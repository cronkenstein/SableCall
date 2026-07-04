/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  AudioPresets,
  Track,
  type LocalParticipant,
  type TrackPublishOptions,
} from "livekit-client";
import { type Logger } from "matrix-js-sdk/lib/logger";
import { type IWidgetApiRequest } from "matrix-widget-api";

import { type Behavior } from "../../Behavior.ts";
import { ElementWidgetActions, widget } from "../../../widget.ts";
import { getUrlParams } from "../../../UrlParams.ts";
import {
  advancedScreenShare,
  parseResolution,
  screenShareBitrate,
  screenShareCodec,
  screenShareFramerate,
  screenShareResolution,
} from "../../../settings/settings.ts";
import { Config } from "../../../config/Config.ts";

/**
 * Native screen share bridge (macOS Tauri host).
 *
 * WKWebView cannot capture system audio through getDisplayMedia, so the
 * hosting client captures natively (ScreenCaptureKit) and streams media over
 * a localhost WebSocket. This manager consumes that stream inside the widget,
 * reconstructs MediaStreamTracks WebKit can publish, and publishes them on
 * the local participant so E2EE and room lifecycle stay identical to a
 * getDisplayMedia share.
 *
 * The WebSocket, protocol parsing, and JPEG decoding run in a dedicated
 * worker: page-visibility throttling (e.g. the sharer covering this window
 * with a fullscreen video) must not starve the pipeline. Video prefers
 * WebKit's worker-scoped VideoTrackGenerator, which produces frames
 * independently of the compositor; older WebKit falls back to a canvas +
 * captureStream on the main thread (which does throttle when occluded —
 * best we can do there). Audio PCM flows from the worker straight into an
 * AudioWorklet through a dedicated MessageChannel, bypassing the main
 * thread entirely.
 */

/** Wire protocol message types (see Sable src-tauri/src/screen_share/protocol.rs). */
const MSG_VIDEO = 0x01;
const MSG_AUDIO = 0x02;
const VIDEO_CODEC_JPEG = 0x01;
const VIDEO_CODEC_H264 = 0x02;
const AUDIO_FORMAT_F32 = 0x01;
const VIDEO_HEADER_LEN = 14;
const AUDIO_HEADER_LEN = 16;

/**
 * Jitter buffer tuning. Steady-state stays inside the 80ms share-side
 * budget (base target 55ms), but the target adapts upward when delivery
 * turns bursty (fullscreen/WindowServer contention on the capture side):
 * each underrun grows the target, sustained clean playback decays it back.
 * Audible gaps are worse than temporarily elevated latency.
 */
const BASE_TARGET_SEC = 0.055;
const MAX_TARGET_SEC = 0.16;
/** Immediate target growth on an actual underrun. */
const TARGET_STEP_SEC = 0.03;
/**
 * Trough-based adaptation: the buffer level oscillates with delivery
 * cadence, so the windowed minimum — not the instantaneous level — decides
 * whether latency headroom is sufficient. Grow before underruns happen,
 * decay only while the trough is provably safe.
 */
const TROUGH_WINDOW_SEC = 0.5;
const TROUGH_LOW_SEC = 0.02;
const TROUGH_SAFE_SEC = 0.04;
const TROUGH_GROW_PAD_SEC = 0.01;
const TARGET_DECAY_PER_WINDOW_SEC = 0.002;
/**
 * Latency removal is trough-based: transient peaks are part of a bursty
 * cadence and must not be clipped (that starves the next inter-burst gap),
 * but a trough persistently above target is real, removable delay.
 */
const TROUGH_EXCESS_SEC = 0.03;
/** Absolute safety: a single huge backlog burst is cut down immediately. */
const HARD_CLAMP_SEC = 0.24;
const DRIFT_GAIN = 0.4;
const MAX_RATE_NUDGE = 0.02;
/** Fade-in time after a discontinuity, and decay constant for the old tail. */
const FADE_SEC = 0.005;
const TAIL_TAU_SEC = 0.004;

interface NativeScreenShareStartPayload {
  wsUrl: string;
  token: string;
  width: number;
  height: number;
  frameRate: number;
  sampleRate: number;
  channels: number;
  /** Wire codec chosen by the host ("h264" or "jpeg"); informational. */
  codec?: string;
}

/**
 * Whether the hosting client provides native screen share via the
 * io.sable.screen_share.* widget actions.
 */
export function isNativeScreenShareMode(): boolean {
  const { nativeScreenShare, hideScreensharing } = getUrlParams();
  return widget !== null && nativeScreenShare === true && !hideScreensharing;
}

/**
 * Publish options for the native screen share video track, mirroring the
 * getDisplayMedia path in LocalMember. A bare publishTrack leaves the track
 * without bitrate caps, content hints, or degradation preferences — when a
 * camera track joins the connection, bandwidth estimation then slowly
 * squeezes the uncapped share until quality collapses (recovering briefly
 * on renegotiation, i.e. camera restarts).
 */
function videoPublishOptions(frameRate: number): TrackPublishOptions {
  const options: TrackPublishOptions = {
    source: Track.Source.ScreenShare,
    simulcast: false,
    // Screen content: hold resolution and let framerate give way instead.
    degradationPreference: "maintain-resolution",
    // Deliberately no videoCodec override: the room default (VP8) is the
    // universally-decodable WebRTC codec. LiveKit's backupCodec rescue for
    // incapable subscribers is DISABLED under E2EE (see publish path:
    // "TODO remove this once e2ee is supported for backup codecs"), so
    // forcing H.264 here permanently blanked the share for viewers without
    // H.264 WebRTC decode (codec-free Chromium builds, some Android).
    screenShareEncoding: {
      maxBitrate:
        Config.get().media_quality?.screen_share?.max_bitrate ?? 5_000_000,
      maxFramerate:
        Config.get().media_quality?.screen_share?.max_framerate ?? frameRate,
    },
  };

  if (advancedScreenShare.getValue()) {
    // The user opted into explicit screen share settings; respect them
    // (including their codec choice — same semantics as the web path).
    options.videoCodec = screenShareCodec.getValue();
    options.screenShareEncoding = {
      maxBitrate: screenShareBitrate.getValue(),
      maxFramerate: screenShareFramerate.getValue(),
    };
  }

  return options;
}

/**
 * Audio sink worklet: an adaptive jitter buffer over interleaved f32 PCM
 * chunks. Chunks arrive either directly on the node port or, preferably, on
 * a MessagePort handed over in a `{ port }` handshake message (wired to the
 * media worker so audio survives main-thread throttling).
 *
 * Latency control:
 * - linear-interpolation resampling at chunkRate / contextRate;
 * - playback-rate nudge (±2%) steering fill toward TARGET_SEC, which
 *   cancels clock drift between capture and the audio device;
 * - hard drop of oldest chunks back to TARGET_SEC when fill exceeds
 *   MAX_SEC, keeping the share-side delay inside the 80ms budget;
 * - underruns re-enter prebuffering rather than splicing silence into the
 *   middle of the stream.
 *
 * Declicking: every discontinuity (drop or underrun) fades the new audio in
 * over FADE_SEC while the last sample decays with TAIL_TAU_SEC, so drops
 * produce a soft thump instead of a sharp click.
 */
const AUDIO_SINK_WORKLET = `
const BASE_TARGET_SEC = ${BASE_TARGET_SEC};
const MAX_TARGET_SEC = ${MAX_TARGET_SEC};
const TARGET_STEP_SEC = ${TARGET_STEP_SEC};
const TROUGH_WINDOW_SEC = ${TROUGH_WINDOW_SEC};
const TROUGH_LOW_SEC = ${TROUGH_LOW_SEC};
const TROUGH_SAFE_SEC = ${TROUGH_SAFE_SEC};
const TROUGH_GROW_PAD_SEC = ${TROUGH_GROW_PAD_SEC};
const TARGET_DECAY_PER_WINDOW_SEC = ${TARGET_DECAY_PER_WINDOW_SEC};
const TROUGH_EXCESS_SEC = ${TROUGH_EXCESS_SEC};
const HARD_CLAMP_SEC = ${HARD_CLAMP_SEC};
const DRIFT_GAIN = ${DRIFT_GAIN};
const MAX_RATE_NUDGE = ${MAX_RATE_NUDGE};

class NativeScreenShareSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    // Fractional read position (in source frames) within chunks[0].
    this.readPos = 0;
    this.started = false;
    // Adaptive latency target: grows on underruns and thin troughs,
    // decays only while the windowed trough is safely above zero.
    this.targetSec = BASE_TARGET_SEC;
    this.troughSec = Infinity;
    this.windowFrames = 0;
    this.gain = 0;
    this.gainStep = 1 / (${FADE_SEC} * sampleRate);
    this.tailDecay = Math.exp(-1 / (${TAIL_TAU_SEC} * sampleRate));
    this.tail = [0, 0];
    this.lastOut = [0, 0];
    this.discontinuity = false;
    // Observability heartbeat (5s of output frames).
    this.statUnderruns = 0;
    this.statClampDrops = 0;
    this.statChunks = 0;
    this.statFrames = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.port) {
        // Direct channel from the media worker.
        data.port.onmessage = (ev) => this.enqueue(ev.data);
        return;
      }
      this.enqueue(data);
    };
  }

  enqueue(chunk) {
    if (!chunk || !(chunk.samples instanceof Float32Array) || !chunk.channels) return;
    chunk.rate = chunk.rate > 0 ? chunk.rate : 48000;
    chunk.frames = chunk.samples.length / chunk.channels;
    if (chunk.frames < 1) return;
    this.statChunks++;
    this.chunks.push(chunk);
    // Safety clamp for a single huge backlog burst (e.g. delivery resumed
    // after a long stall). Ordinary cadence peaks are left alone — the
    // trough logic in process() decides what latency is truly removable.
    if (this.bufferedSeconds() > HARD_CLAMP_SEC) {
      while (this.chunks.length > 1 && this.bufferedSeconds() > this.targetSec) {
        this.chunks.shift();
        this.readPos = 0;
      }
      this.statClampDrops++;
      this.discontinuity = true;
    }
  }

  dropOldest(seconds) {
    this.statClampDrops++;
    let remaining = seconds;
    while (remaining > 0 && this.chunks.length > 1) {
      const chunk = this.chunks[0];
      const chunkSeconds = (chunk.frames - this.readPos) / chunk.rate;
      if (chunkSeconds > remaining) break;
      remaining -= chunkSeconds;
      this.chunks.shift();
      this.readPos = 0;
    }
    this.discontinuity = true;
  }

  bufferedSeconds() {
    let seconds = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const remaining = i === 0 ? chunk.frames - this.readPos : chunk.frames;
      seconds += remaining / chunk.rate;
    }
    return seconds;
  }

  emitTail(output, from, to) {
    for (let frame = from; frame < to; frame++) {
      for (let ch = 0; ch < output.length; ch++) {
        const t = ch < this.tail.length ? this.tail[ch] : 0;
        output[ch][frame] = t;
        // Keep lastOut tracking what actually reached the speaker, so a
        // later crossfade never resurrects a stale full-scale sample.
        this.lastOut[ch] = t;
        this.tail[ch] = t * this.tailDecay;
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frameCount = output[0].length;

    const buffered = this.bufferedSeconds();
    if (!this.started) {
      // Prebuffer up to the adaptive target before (re)starting.
      if (buffered < this.targetSec) {
        this.emitTail(output, 0, frameCount);
        return true;
      }
      this.started = true;
      this.gain = 0;
    }

    // Trough tracking: adapt the target to the delivery cadence actually
    // observed, before it produces an audible underrun.
    this.troughSec = Math.min(this.troughSec, buffered);
    this.windowFrames += frameCount;
    if (this.windowFrames >= sampleRate * TROUGH_WINDOW_SEC) {
      if (this.troughSec < TROUGH_LOW_SEC) {
        this.targetSec = Math.min(
          MAX_TARGET_SEC,
          this.targetSec + (TROUGH_LOW_SEC - this.troughSec) + TROUGH_GROW_PAD_SEC,
        );
      } else if (this.troughSec > this.targetSec + TROUGH_EXCESS_SEC) {
        // Even the lowest point of the cycle carries excess latency;
        // remove it (softened by the crossfade).
        this.dropOldest(this.troughSec - this.targetSec);
      } else if (this.troughSec > TROUGH_SAFE_SEC) {
        this.targetSec = Math.max(
          BASE_TARGET_SEC,
          this.targetSec - TARGET_DECAY_PER_WINDOW_SEC,
        );
      }
      this.windowFrames = 0;
      this.troughSec = Infinity;
    }

    if (this.discontinuity) {
      // Crossfade over the jump: old audio decays, new audio fades in.
      // Consumed after the window check so that drops made there are
      // faded within this same quantum.
      this.discontinuity = false;
      this.gain = 0;
      for (let ch = 0; ch < output.length; ch++) this.tail[ch] = this.lastOut[ch];
    }

    // Steer buffer fill toward the target with a gentle playback rate
    // adjustment; this is what cancels clock drift.
    let nudge = 1 + DRIFT_GAIN * (buffered - this.targetSec);
    if (nudge > 1 + MAX_RATE_NUDGE) nudge = 1 + MAX_RATE_NUDGE;
    if (nudge < 1 - MAX_RATE_NUDGE) nudge = 1 - MAX_RATE_NUDGE;

    for (let frame = 0; frame < frameCount; frame++) {
      const chunk = this.chunks[0];
      if (!chunk) {
        // Underrun: decay to silence and re-prebuffer. Delivery is proving
        // burstier than the current target, so grow it — audible gaps are
        // worse than temporarily elevated latency.
        this.started = false;
        this.readPos = 0;
        this.statUnderruns++;
        this.targetSec = Math.min(MAX_TARGET_SEC, this.targetSec + TARGET_STEP_SEC);
        this.windowFrames = 0;
        this.troughSec = Infinity;
        for (let ch = 0; ch < output.length; ch++) this.tail[ch] = this.lastOut[ch];
        this.emitTail(output, frame, frameCount);
        return true;
      }

      const channels = chunk.channels;
      const i0 = Math.floor(this.readPos);
      const t = this.readPos - i0;
      // Interpolate across the chunk boundary: the stream is contiguous, so
      // the next chunk's first frame is the correct right-hand sample.
      const atEnd = i0 + 1 >= chunk.frames;
      const next = atEnd ? this.chunks[1] : null;
      for (let ch = 0; ch < output.length; ch++) {
        const src = Math.min(ch, channels - 1);
        const a = chunk.samples[i0 * channels + src];
        const b = atEnd
          ? (next ? next.samples[Math.min(src, next.channels - 1)] : a)
          : chunk.samples[(i0 + 1) * channels + src];
        const tailValue = ch < this.tail.length ? this.tail[ch] : 0;
        const value = (a + (b - a) * t) * this.gain + tailValue;
        output[ch][frame] = value;
        this.lastOut[ch] = value;
        this.tail[ch] = tailValue * this.tailDecay;
      }
      this.gain = Math.min(1, this.gain + this.gainStep);

      this.readPos += (chunk.rate / sampleRate) * nudge;
      while (this.chunks.length > 0 && this.readPos >= this.chunks[0].frames) {
        this.readPos -= this.chunks[0].frames;
        this.chunks.shift();
      }
    }

    this.statFrames += frameCount;
    if (this.statFrames >= sampleRate * 60) {
      this.port.postMessage({
        type: "stats",
        chunks: this.statChunks,
        underruns: this.statUnderruns,
        clampDrops: this.statClampDrops,
        targetMs: Math.round(this.targetSec * 1000),
        bufferedMs: Math.round(buffered * 1000),
      });
      this.statChunks = 0;
      this.statUnderruns = 0;
      this.statClampDrops = 0;
      this.statFrames = 0;
    }
    return true;
  }
}
registerProcessor("native-screen-share-sink", NativeScreenShareSink);
`;

/**
 * Media worker: owns the WebSocket, protocol parsing, and JPEG decoding so
 * none of it is subject to page-visibility throttling. Video goes through
 * VideoTrackGenerator when this WebKit exposes it (the generated track is
 * transferred to the main thread for publishing); otherwise decoded
 * ImageBitmaps are posted to the main thread for the canvas fallback.
 * Audio PCM goes straight to the AudioWorklet via a transferred MessagePort.
 */
const MEDIA_WORKER = `
const MSG_VIDEO = ${MSG_VIDEO};
const MSG_AUDIO = ${MSG_AUDIO};
const VIDEO_CODEC_JPEG = ${VIDEO_CODEC_JPEG};
const VIDEO_CODEC_H264 = ${VIDEO_CODEC_H264};
const AUDIO_FORMAT_F32 = ${AUDIO_FORMAT_F32};
const VIDEO_HEADER_LEN = ${VIDEO_HEADER_LEN};
const AUDIO_HEADER_LEN = ${AUDIO_HEADER_LEN};

let ws = null;
let writer = null;
let generatorTrack = null;
let audioPort = null;
let pendingVideo = null;
let decoding = false;
let videoDecoder = null;
let pendingWrite = false;
// SCK timestamps are host-clock microseconds (huge absolute values);
// rebase to zero so the encoder sees a sane, monotonic timeline.
let baseTimestamp = null;

// KEEP-ALIVE — load-bearing, do not remove. When the hosting window is
// fully occluded (e.g. the sharer views a fullscreen Space), macOS
// deschedules the WebContent process ~5-10s after occlusion despite the
// host's scheduling knobs, starving the entire bridge (video and audio).
// Periodic observable activity defeats the idle heuristic. This was
// discovered when 5s diagnostics accidentally fixed the stutter.
const keepAliveTimer = setInterval(() => {
  self.postMessage({ type: "tick" });
}, 2000);

// Observability heartbeat: 60s deltas posted to the main thread. A stalled
// heartbeat is itself a signal — it means this worker stopped being
// scheduled entirely. Deliberately outside the ~5-10s suspension grace
// window so the keep-alive above is provably the only masking activity.
let stats = { video: 0, audio: 0, decoded: 0, written: 0, writeDropped: 0, bitmaps: 0, decodeErrors: 0 };
const statsTimer = setInterval(() => {
  self.postMessage({
    type: "stats",
    video: stats.video,
    audio: stats.audio,
    decoded: stats.decoded,
    written: stats.written,
    writeDropped: stats.writeDropped,
    bitmaps: stats.bitmaps,
    decodeErrors: stats.decodeErrors,
    queue: videoDecoder ? videoDecoder.decodeQueueSize : -1,
  });
  stats = { video: 0, audio: 0, decoded: 0, written: 0, writeDropped: 0, bitmaps: 0, decodeErrors: 0 };
}, 60000);

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "init") {
    audioPort = msg.audioPort || null;
    initVideoPath();
    connect(msg.wsUrl, msg.token);
  } else if (msg.type === "stop") {
    cleanup();
  }
};

function initVideoPath() {
  try {
    if (typeof VideoTrackGenerator === "function") {
      const generator = new VideoTrackGenerator();
      writer = generator.writable.getWriter();
      generatorTrack = generator.track;
      // Track transfer can fail independently of the constructor.
      self.postMessage({ type: "ready", track: generatorTrack }, [generatorTrack]);
      return;
    }
  } catch (e) {
    try { if (generatorTrack) generatorTrack.stop(); } catch (_) {}
    writer = null;
    generatorTrack = null;
  }
  self.postMessage({ type: "ready" });
}

function connect(wsUrl, token) {
  ws = new WebSocket(wsUrl + "?token=" + encodeURIComponent(token));
  ws.binaryType = "arraybuffer";
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) onMedia(event.data);
  };
  ws.onclose = () => self.postMessage({ type: "closed" });
  ws.onerror = () => self.postMessage({ type: "socket-error" });
}

function onMedia(buffer) {
  if (buffer.byteLength < 1) return;
  const view = new DataView(buffer);
  switch (view.getUint8(0)) {
    case MSG_VIDEO: {
      if (buffer.byteLength <= VIDEO_HEADER_LEN) return;
      const codec = view.getUint8(1);
      stats.video++;
      if (codec === VIDEO_CODEC_H264) {
        handleH264(buffer, view);
      } else if (codec === VIDEO_CODEC_JPEG) {
        // Latest wins: only the most recent undecoded frame is kept.
        pendingVideo = buffer;
        drainVideo();
      }
      break;
    }
    case MSG_AUDIO: {
      if (buffer.byteLength <= AUDIO_HEADER_LEN || !audioPort) return;
      if (view.getUint8(1) !== AUDIO_FORMAT_F32) return;
      const channels = view.getUint8(2);
      if (channels < 1) return;
      const rate = view.getUint32(4, true);
      const samples = new Float32Array(
        buffer,
        AUDIO_HEADER_LEN,
        (buffer.byteLength - AUDIO_HEADER_LEN) >> 2,
      );
      stats.audio++;
      audioPort.postMessage({ samples, channels, rate }, [buffer]);
      break;
    }
  }
}

function rebaseTimestamp(view) {
  const raw = Number(view.getBigUint64(6, true));
  if (baseTimestamp === null) baseTimestamp = raw;
  return Math.max(0, raw - baseTimestamp);
}

// Walks Annex B start codes; cb(nalType, payloadOffset) returns true to stop.
function forEachNal(data, cb) {
  let i = 0;
  while (i + 3 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0) {
      let start = -1;
      if (data[i + 2] === 1) start = i + 3;
      else if (data[i + 2] === 0 && data[i + 3] === 1) start = i + 4;
      if (start > 0 && start < data.length) {
        if (cb(data[start] & 0x1f, start)) return;
        i = start;
        continue;
      }
    }
    i++;
  }
}

function disposeDecoder() {
  if (videoDecoder) {
    stats.decodeErrors++;
    try { videoDecoder.close(); } catch (e) {}
    videoDecoder = null;
  }
}

async function onDecodedFrame(frame) {
  stats.decoded++;
  if (writer) {
    if (pendingWrite) {
      // Latest-wins after decode: never queue stale frames behind a slow sink.
      stats.writeDropped++;
      frame.close();
      return;
    }
    pendingWrite = true;
    try {
      await writer.write(frame);
      stats.written++;
    } catch (e) {
      // Sink gone (teardown); frame ownership passed regardless.
    } finally {
      pendingWrite = false;
    }
  } else {
    try {
      const bitmap = await createImageBitmap(frame);
      stats.bitmaps++;
      self.postMessage(
        { type: "bitmap", bitmap, width: frame.displayWidth, height: frame.displayHeight },
        [bitmap],
      );
    } catch (e) {}
    frame.close();
  }
}

function handleH264(buffer, view) {
  const timestamp = rebaseTimestamp(view);
  const payload = new Uint8Array(buffer, VIDEO_HEADER_LEN);
  let isKey = false;
  let spsOffset = -1;
  forEachNal(payload, (type, offset) => {
    if (type === 5) isKey = true;
    if (type === 7 && spsOffset < 0) spsOffset = offset;
    return isKey && spsOffset >= 0;
  });

  if (!videoDecoder) {
    // Configuration comes from the bitstream: wait for a keyframe whose
    // in-band SPS yields the codec string (profile/constraints/level).
    if (!isKey || spsOffset < 0 || spsOffset + 3 >= payload.length) return;
    const codec =
      "avc1." +
      [1, 2, 3]
        .map((i) => payload[spsOffset + i].toString(16).padStart(2, "0"))
        .join("");
    try {
      videoDecoder = new VideoDecoder({
        output: onDecodedFrame,
        // On error, drop the decoder; the next keyframe (<=2s) rebuilds it.
        error: () => disposeDecoder(),
      });
      videoDecoder.configure({ codec, optimizeForLatency: true });
    } catch (e) {
      disposeDecoder();
      return;
    }
  }

  // Backlogged decoder: skip deltas and resync on the next keyframe.
  if (videoDecoder.decodeQueueSize > 8 && !isKey) return;
  try {
    videoDecoder.decode(
      new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp,
        data: payload,
      }),
    );
  } catch (e) {
    disposeDecoder();
  }
}

async function drainVideo() {
  if (decoding) return;
  decoding = true;
  try {
    while (pendingVideo) {
      const buffer = pendingVideo;
      pendingVideo = null;
      const view = new DataView(buffer);
      const width = view.getUint16(2, true);
      const height = view.getUint16(4, true);
      const timestamp = rebaseTimestamp(view);
      try {
        const bitmap = await createImageBitmap(
          new Blob([buffer.slice(VIDEO_HEADER_LEN)], { type: "image/jpeg" }),
        );
        if (writer) {
          const frame = new VideoFrame(bitmap, { timestamp });
          bitmap.close();
          // The writable sink takes ownership of the frame.
          await writer.write(frame);
        } else {
          self.postMessage({ type: "bitmap", bitmap, width, height }, [bitmap]);
        }
      } catch (e) {
        // Skip undecodable frames; the next one supersedes them anyway.
      }
    }
  } finally {
    decoding = false;
  }
}

function cleanup() {
  clearInterval(keepAliveTimer);
  clearInterval(statsTimer);
  try { if (ws) ws.close(); } catch (_) {}
  disposeDecoder();
  try { if (writer) writer.close(); } catch (_) {}
  ws = null;
  writer = null;
}
`;

interface MediaWorkerReadyMessage {
  type: "ready";
  track?: MediaStreamTrack;
}

interface MediaWorkerBitmapMessage {
  type: "bitmap";
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

interface MediaWorkerStatsMessage {
  type: "stats";
  video: number;
  audio: number;
  decoded: number;
  written: number;
  writeDropped: number;
  bitmaps: number;
  decodeErrors: number;
  queue: number;
}

type MediaWorkerMessage =
  | MediaWorkerReadyMessage
  | MediaWorkerBitmapMessage
  | MediaWorkerStatsMessage
  | { type: "tick" }
  | { type: "closed" }
  | { type: "socket-error" };

interface ActiveSession {
  worker: Worker;
  workerUrl: string;
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  videoTrack: MediaStreamTrack | null;
  audioContext: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  audioTrack: MediaStreamTrack | null;
  participant: LocalParticipant;
  published: boolean;
  stopped: boolean;
}

export class NativeScreenShareManager {
  private session: ActiveSession | null = null;

  private readonly logger: Logger;

  public constructor(
    private readonly participant$: Behavior<LocalParticipant | null>,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.getChild("[NativeScreenShare]");
    widget?.lazyActions.on(
      ElementWidgetActions.ScreenShareStart,
      this.onStartAction,
    );
    widget?.lazyActions.on(
      ElementWidgetActions.ScreenShareStop,
      this.onStopAction,
    );
  }

  /**
   * Asks the hosting client to toggle native capture. The share does not
   * start/stop here: the host replies with ScreenShareStart/Stop actions
   * once capture state actually changes.
   */
  public requestToggle(currentlySharing: boolean): void {
    this.logger.info(
      `Requesting native screen share toggle (sharing=${currentlySharing})`,
    );
    const payload: Record<string, unknown> = {
      sharing: currentlySharing,
      // The host encodes H.264 (hardware) when we can decode it; JPEG is
      // the mutual fallback.
      videoCodecs:
        typeof VideoDecoder === "function" ? ["h264", "jpeg"] : ["jpeg"],
    };
    if (advancedScreenShare.getValue()) {
      const { width, height } = parseResolution(
        screenShareResolution.getValue(),
      );
      payload.maxWidth = width;
      payload.maxHeight = height;
      payload.frameRate = screenShareFramerate.getValue();
    }
    widget?.api.transport
      .send(ElementWidgetActions.ScreenShareToggleRequest, payload)
      .catch((e) => {
        this.logger.error("Failed to send screen share toggle request", e);
      });
  }

  public dispose(): void {
    widget?.lazyActions.off(
      ElementWidgetActions.ScreenShareStart,
      this.onStartAction,
    );
    widget?.lazyActions.off(
      ElementWidgetActions.ScreenShareStop,
      this.onStopAction,
    );
    void this.stop();
  }

  private readonly onStartAction = (
    ev: CustomEvent<IWidgetApiRequest>,
  ): void => {
    widget?.api.transport.reply(ev.detail, {});
    const payload = ev.detail.data as unknown as NativeScreenShareStartPayload;
    void this.start(payload).catch((e) => {
      this.logger.error("Failed to start native screen share", e);
      this.sendStatus(false, e instanceof Error ? e.message : String(e));
      void this.stop();
    });
  };

  private readonly onStopAction = (
    ev: CustomEvent<IWidgetApiRequest>,
  ): void => {
    widget?.api.transport.reply(ev.detail, {});
    void this.stop();
  };

  private sendStatus(active: boolean, error?: string): void {
    widget?.api.transport
      .send(ElementWidgetActions.ScreenShareStatus, { active, error })
      .catch((e) => {
        this.logger.error("Failed to send screen share status", e);
      });
  }

  private async start(payload: NativeScreenShareStartPayload): Promise<void> {
    if (this.session) await this.stop();

    const participant = this.participant$.value;
    if (!participant) {
      throw new Error("No LiveKit participant to publish screen share on");
    }
    if (
      !payload?.wsUrl ||
      !payload.token ||
      !(payload.width > 0) ||
      !(payload.height > 0)
    ) {
      throw new Error("Invalid native screen share start payload");
    }
    this.logger.info(
      `Starting native screen share ${payload.width}x${payload.height}@${payload.frameRate} (${payload.codec ?? "jpeg"})`,
    );

    // Audio graph first, so its MessagePort can be handed to the worker.
    // Best-effort — video must still work if the audio graph cannot start
    // on this WebKit version.
    let audioContext: AudioContext | null = null;
    let workletNode: AudioWorkletNode | null = null;
    let audioTrack: MediaStreamTrack | null = null;
    let workerAudioPort: MessagePort | null = null;
    try {
      audioContext = new AudioContext({
        sampleRate: payload.sampleRate > 0 ? payload.sampleRate : 48_000,
      });
      const workletUrl = URL.createObjectURL(
        new Blob([AUDIO_SINK_WORKLET], { type: "application/javascript" }),
      );
      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const channels = payload.channels > 0 ? Math.min(payload.channels, 2) : 2;
      workletNode = new AudioWorkletNode(
        audioContext,
        "native-screen-share-sink",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [channels],
        },
      );
      const destination = audioContext.createMediaStreamDestination();
      workletNode.connect(destination);
      if (audioContext.state === "suspended") await audioContext.resume();
      // The worklet resamples by the per-chunk rate, so a mismatch here is
      // handled — but it is worth knowing about when debugging latency.
      if (audioContext.sampleRate !== payload.sampleRate) {
        this.logger.warn(
          `AudioContext runs at ${audioContext.sampleRate}Hz, capture at ${payload.sampleRate}Hz; worklet will resample`,
        );
      } else {
        this.logger.info(
          `AudioContext running at ${audioContext.sampleRate}Hz`,
        );
      }
      // Audio bypasses the main thread: worker → MessagePort → worklet.
      const channel = new MessageChannel();
      workletNode.port.postMessage({ port: channel.port1 }, [channel.port1]);
      workerAudioPort = channel.port2;
      // The worklet reports its jitter-buffer heartbeat on the node port.
      workletNode.port.onmessage = (event: MessageEvent): void => {
        const data = event.data as
          | {
              type?: string;
              chunks?: number;
              underruns?: number;
              clampDrops?: number;
              targetMs?: number;
              bufferedMs?: number;
            }
          | undefined;
        if (data?.type === "stats") {
          this.logger.info(
            `audio sink 5s: chunks=${data.chunks} underruns=${data.underruns} ` +
              `drops=${data.clampDrops} target=${data.targetMs}ms buf=${data.bufferedMs}ms`,
          );
        }
      };
      audioTrack = destination.stream.getAudioTracks()[0] ?? null;
    } catch (e) {
      this.logger.error(
        "Screen share audio pipeline unavailable; sharing video only",
        e,
      );
      audioContext = null;
      workletNode = null;
      audioTrack = null;
      workerAudioPort = null;
    }

    const workerUrl = URL.createObjectURL(
      new Blob([MEDIA_WORKER], { type: "application/javascript" }),
    );
    const worker = new Worker(workerUrl);

    const session: ActiveSession = {
      worker,
      workerUrl,
      canvas: null,
      context: null,
      videoTrack: null,
      audioContext,
      workletNode,
      audioTrack,
      participant,
      published: false,
      stopped: false,
    };
    this.session = session;

    const ready = new Promise<MediaWorkerReadyMessage>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("media worker did not become ready")),
        5000,
      );
      worker.onmessage = (event: MessageEvent<MediaWorkerMessage>): void => {
        const msg = event.data;
        if (msg?.type === "ready") {
          clearTimeout(timeout);
          resolve(msg);
          return;
        }
        this.onWorkerMessage(session, msg);
      };
      worker.onerror = (event): void => {
        clearTimeout(timeout);
        reject(new Error(`media worker error: ${event.message}`));
      };
    });

    worker.postMessage(
      {
        type: "init",
        wsUrl: payload.wsUrl,
        token: payload.token,
        audioPort: workerAudioPort ?? undefined,
      },
      workerAudioPort ? [workerAudioPort] : [],
    );

    const readyMessage = await ready;
    worker.onmessage = (event: MessageEvent<MediaWorkerMessage>): void => {
      this.onWorkerMessage(session, event.data);
    };

    if (readyMessage.track instanceof MediaStreamTrack) {
      // Worker-generated track: frame delivery is independent of the
      // compositor, so occluding this window does not stall the share.
      session.videoTrack = readyMessage.track;
      this.logger.info("Using worker VideoTrackGenerator video path");
    } else {
      session.videoTrack = this.setupCanvasFallback(session, payload);
      this.logger.info(
        "VideoTrackGenerator unavailable; using canvas captureStream fallback",
      );
    }

    try {
      // Screen content wants detail preserved over smooth motion.
      session.videoTrack.contentHint = "detail";
    } catch {
      // Older WebKit without contentHint; purely advisory.
    }
    await participant.publishTrack(
      session.videoTrack,
      videoPublishOptions(payload.frameRate),
    );
    if (session.audioTrack) {
      const stereo = (payload.channels > 0 ? payload.channels : 2) >= 2;
      await participant.publishTrack(session.audioTrack, {
        source: Track.Source.ScreenShareAudio,
        dtx: false,
        red: false,
        // LiveKit's stereo auto-detection reads getSettings().channelCount,
        // which synthesized (destination-node) tracks may not report in
        // WKWebView; without this, stereo system audio downmixes to mono.
        forceStereo: stereo,
        // Default is music (48kbps mono-oriented); media content deserves
        // the stereo preset.
        audioPreset: stereo ? AudioPresets.musicStereo : AudioPresets.music,
      });
    }
    session.published = true;
    this.sendStatus(true);
    this.logger.info("Native screen share tracks published");
  }

  private setupCanvasFallback(
    session: ActiveSession,
    payload: NativeScreenShareStartPayload,
  ): MediaStreamTrack {
    // The canvas must be in the DOM for captureStream to produce frames
    // reliably in WebKit; park it off-viewport.
    const canvas = document.createElement("canvas");
    canvas.width = payload.width;
    canvas.height = payload.height;
    canvas.style.position = "fixed";
    canvas.style.left = "-99999px";
    canvas.style.top = "0";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    const context = canvas.getContext("2d");
    if (!context) {
      canvas.remove();
      throw new Error("Could not create 2d canvas context");
    }
    const frameRate =
      payload.frameRate > 0 && payload.frameRate <= 60 ? payload.frameRate : 30;
    const videoTrack = canvas.captureStream(frameRate).getVideoTracks()[0];
    if (!videoTrack) {
      canvas.remove();
      throw new Error("canvas.captureStream produced no video track");
    }
    session.canvas = canvas;
    session.context = context;
    return videoTrack;
  }

  private onWorkerMessage(
    session: ActiveSession,
    msg: MediaWorkerMessage,
  ): void {
    if (session.stopped || !msg) return;
    switch (msg.type) {
      case "bitmap": {
        const { bitmap, width, height } = msg;
        if (!session.canvas || !session.context) {
          bitmap.close();
          return;
        }
        if (
          session.canvas.width !== width ||
          session.canvas.height !== height
        ) {
          session.canvas.width = width;
          session.canvas.height = height;
        }
        session.context.drawImage(bitmap, 0, 0);
        bitmap.close();
        // Push the frame explicitly where supported, instead of waiting for
        // the (occlusion-throttled) compositor to sample the canvas.
        (
          session.videoTrack as MediaStreamTrack & {
            requestFrame?: () => void;
          }
        ).requestFrame?.();
        break;
      }
      case "tick":
        // Keep-alive from the worker (see MEDIA_WORKER): receiving it here
        // puts a task on the main thread every 2s, which together with the
        // worker's timer keeps macOS from descheduling this process while
        // the hosting window is occluded. Intentionally does nothing.
        break;
      case "stats":
        // Mirrors the host-side heartbeat: recv counts show what crossed
        // the socket; decode/write counts show what survived this process.
        this.logger.info(
          `bridge 5s: recv v=${msg.video} a=${msg.audio} | decoded=${msg.decoded} q=${msg.queue} ` +
            `decErr=${msg.decodeErrors} | written=${msg.written} wDrop=${msg.writeDropped} bmp=${msg.bitmaps}`,
        );
        break;
      case "closed":
        this.logger.info("Native screen share media socket closed");
        void this.stop();
        break;
      case "socket-error":
        this.logger.error("Native screen share media socket error");
        this.sendStatus(false, "media socket error");
        void this.stop();
        break;
      default:
        break;
    }
  }

  private async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.stopped = true;
    this.logger.info("Stopping native screen share");

    session.worker.postMessage({ type: "stop" });
    session.worker.terminate();
    URL.revokeObjectURL(session.workerUrl);

    if (session.published && session.videoTrack) {
      await session.participant
        .unpublishTrack(session.videoTrack, true)
        .catch((e) => this.logger.error("Failed to unpublish video track", e));
      if (session.audioTrack) {
        await session.participant
          .unpublishTrack(session.audioTrack, true)
          .catch((e) =>
            this.logger.error("Failed to unpublish audio track", e),
          );
      }
    }
    session.videoTrack?.stop();
    session.audioTrack?.stop();
    session.workletNode?.disconnect();
    if (session.audioContext) {
      await session.audioContext
        .close()
        .catch((e) => this.logger.warn("Failed to close audio context", e));
    }
    session.canvas?.remove();
    this.sendStatus(false);
  }
}
