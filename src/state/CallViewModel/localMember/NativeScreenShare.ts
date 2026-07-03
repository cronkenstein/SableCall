/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { Track, type LocalParticipant } from "livekit-client";
import { type Logger } from "matrix-js-sdk/lib/logger";
import { type IWidgetApiRequest } from "matrix-widget-api";

import { type Behavior } from "../../Behavior.ts";
import { ElementWidgetActions, widget } from "../../../widget.ts";
import { getUrlParams } from "../../../UrlParams.ts";

/**
 * Native screen share bridge (macOS Tauri host).
 *
 * WKWebView cannot capture system audio through getDisplayMedia, so the
 * hosting client captures natively (ScreenCaptureKit) and streams media over
 * a localhost WebSocket. This manager consumes that stream inside the widget,
 * reconstructs MediaStreamTracks WebKit can publish — canvas.captureStream()
 * for video, AudioWorklet → MediaStreamAudioDestinationNode for audio — and
 * publishes them on the local participant so E2EE and room lifecycle stay
 * identical to a getDisplayMedia share.
 */

/** Wire protocol message types (see Sable src-tauri/src/screen_share/protocol.rs). */
const MSG_VIDEO = 0x01;
const MSG_AUDIO = 0x02;
const VIDEO_CODEC_JPEG = 0x01;
const AUDIO_FORMAT_F32 = 0x01;
const VIDEO_HEADER_LEN = 14;
const AUDIO_HEADER_LEN = 16;

interface NativeScreenShareStartPayload {
  wsUrl: string;
  token: string;
  width: number;
  height: number;
  frameRate: number;
  sampleRate: number;
  channels: number;
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
 * Audio sink worklet: consumes interleaved f32 PCM chunks posted from the
 * main thread and plays them out, deinterleaving into the output channels.
 *
 * This is a small adaptive jitter buffer. Latency must stay bounded for the
 * whole share, so beyond a ~60ms prebuffer it:
 *
 * - resamples via linear interpolation at chunkRate / contextRate, which
 *   also absorbs an AudioContext that did not honor the requested rate;
 * - nudges the playback rate ±2% based on buffer fill, so slow clock drift
 *   between the capture side and the audio device never accumulates;
 * - hard-drops the oldest chunks back to ~120ms whenever the buffer exceeds
 *   ~300ms (e.g. after the tab was starved), trading a click for latency;
 * - re-enters prebuffering after an underrun instead of inserting silence
 *   into the middle of the stream, which would permanently add delay.
 */
const AUDIO_SINK_WORKLET = `
const PREBUFFER_SEC = 0.06;
const TARGET_SEC = 0.12;
const MAX_SEC = 0.3;
const DRIFT_GAIN = 0.15;
const MAX_RATE_NUDGE = 0.02;

class NativeScreenShareSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    // Fractional read position (in source frames) within chunks[0].
    this.readPos = 0;
    this.started = false;
    this.port.onmessage = (event) => {
      const chunk = event.data;
      if (!chunk || !(chunk.samples instanceof Float32Array) || !chunk.channels) return;
      chunk.rate = chunk.rate > 0 ? chunk.rate : 48000;
      chunk.frames = chunk.samples.length / chunk.channels;
      if (chunk.frames < 1) return;
      this.chunks.push(chunk);
      // Latency clamp: if the buffer ballooned, drop oldest audio down to
      // the target rather than letting the delay persist forever.
      if (this.bufferedSeconds() > MAX_SEC) {
        while (this.chunks.length > 1 && this.bufferedSeconds() > TARGET_SEC) {
          this.chunks.shift();
          this.readPos = 0;
        }
      }
    };
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

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frameCount = output[0].length;
    const buffered = this.bufferedSeconds();

    if (!this.started) {
      if (buffered < PREBUFFER_SEC) return true; // silence while prebuffering
      this.started = true;
    }

    // Steer buffer fill toward the target with a gentle, inaudible-ish
    // playback rate adjustment; this is what cancels clock drift.
    let nudge = 1 + DRIFT_GAIN * (buffered - TARGET_SEC);
    if (nudge > 1 + MAX_RATE_NUDGE) nudge = 1 + MAX_RATE_NUDGE;
    if (nudge < 1 - MAX_RATE_NUDGE) nudge = 1 - MAX_RATE_NUDGE;

    for (let frame = 0; frame < frameCount; frame++) {
      const chunk = this.chunks[0];
      if (!chunk) {
        // Underrun: emit silence and re-prebuffer. Resuming only once the
        // buffer refills keeps the gap from becoming permanent delay.
        this.started = false;
        this.readPos = 0;
        for (let ch = 0; ch < output.length; ch++) {
          for (let rest = frame; rest < frameCount; rest++) output[ch][rest] = 0;
        }
        return true;
      }

      const channels = chunk.channels;
      const i0 = Math.floor(this.readPos);
      const i1 = Math.min(i0 + 1, chunk.frames - 1);
      const t = this.readPos - i0;
      for (let ch = 0; ch < output.length; ch++) {
        const src = Math.min(ch, channels - 1);
        const a = chunk.samples[i0 * channels + src];
        const b = chunk.samples[i1 * channels + src];
        output[ch][frame] = a + (b - a) * t;
      }

      this.readPos += (chunk.rate / sampleRate) * nudge;
      while (this.chunks.length > 0 && this.readPos >= this.chunks[0].frames) {
        this.readPos -= this.chunks[0].frames;
        this.chunks.shift();
      }
    }
    return true;
  }
}
registerProcessor("native-screen-share-sink", NativeScreenShareSink);
`;

interface ActiveSession {
  ws: WebSocket;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  videoTrack: MediaStreamTrack;
  audioContext: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  audioTrack: MediaStreamTrack | null;
  participant: LocalParticipant;
  published: boolean;
  pendingVideo: ArrayBuffer | null;
  decoding: boolean;
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
    widget?.api.transport
      .send(ElementWidgetActions.ScreenShareToggleRequest, {
        sharing: currentlySharing,
      })
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
      `Starting native screen share ${payload.width}x${payload.height}@${payload.frameRate}`,
    );

    // Video: frames are decoded into a canvas whose stream WebKit can
    // capture. The canvas must be in the DOM for captureStream to produce
    // frames reliably in WebKit; park it off-viewport.
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

    const ws = new WebSocket(
      `${payload.wsUrl}?token=${encodeURIComponent(payload.token)}`,
    );
    ws.binaryType = "arraybuffer";

    const session: ActiveSession = {
      ws,
      canvas,
      context,
      videoTrack,
      audioContext: null,
      workletNode: null,
      audioTrack: null,
      participant,
      published: false,
      pendingVideo: null,
      decoding: false,
      stopped: false,
    };
    this.session = session;

    // Audio: worklet-fed destination node. Best-effort — video must still
    // work if the audio graph cannot start on this WebKit version.
    try {
      const audioContext = new AudioContext({
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
      const workletNode = new AudioWorkletNode(
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
      session.audioContext = audioContext;
      session.workletNode = workletNode;
      session.audioTrack = destination.stream.getAudioTracks()[0] ?? null;
    } catch (e) {
      this.logger.error(
        "Screen share audio pipeline unavailable; sharing video only",
        e,
      );
    }

    ws.onmessage = (event): void => {
      if (event.data instanceof ArrayBuffer) this.onMediaMessage(event.data);
    };
    ws.onclose = (): void => {
      if (!session.stopped) {
        this.logger.info("Native screen share media socket closed");
        void this.stop();
      }
    };
    ws.onerror = (): void => {
      if (!session.stopped) {
        this.logger.error("Native screen share media socket error");
        this.sendStatus(false, "media socket error");
        void this.stop();
      }
    };

    await participant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
    });
    if (session.audioTrack) {
      await participant.publishTrack(session.audioTrack, {
        source: Track.Source.ScreenShareAudio,
        dtx: false,
        red: false,
      });
    }
    session.published = true;
    this.sendStatus(true);
    this.logger.info("Native screen share tracks published");
  }

  private onMediaMessage(buffer: ArrayBuffer): void {
    const session = this.session;
    if (!session || session.stopped || buffer.byteLength < 1) return;
    const view = new DataView(buffer);

    switch (view.getUint8(0)) {
      case MSG_VIDEO: {
        if (buffer.byteLength <= VIDEO_HEADER_LEN) return;
        if (view.getUint8(1) !== VIDEO_CODEC_JPEG) return;
        // Latest wins: only the most recent undecoded frame is kept.
        session.pendingVideo = buffer;
        void this.drainVideo(session);
        break;
      }
      case MSG_AUDIO: {
        if (buffer.byteLength <= AUDIO_HEADER_LEN || !session.workletNode)
          return;
        if (view.getUint8(1) !== AUDIO_FORMAT_F32) return;
        const channels = view.getUint8(2);
        if (channels < 1) return;
        const rate = view.getUint32(4, true);
        const samples = new Float32Array(
          buffer,
          AUDIO_HEADER_LEN,
          (buffer.byteLength - AUDIO_HEADER_LEN) >> 2,
        );
        session.workletNode.port.postMessage({ samples, channels, rate }, [
          buffer,
        ]);
        break;
      }
      default:
        break;
    }
  }

  private async drainVideo(session: ActiveSession): Promise<void> {
    if (session.decoding) return;
    session.decoding = true;
    try {
      while (!session.stopped && session.pendingVideo) {
        const buffer = session.pendingVideo;
        session.pendingVideo = null;
        const view = new DataView(buffer);
        const width = view.getUint16(2, true);
        const height = view.getUint16(4, true);
        try {
          const bitmap = await createImageBitmap(
            new Blob([buffer.slice(VIDEO_HEADER_LEN)], { type: "image/jpeg" }),
          );
          if (
            session.canvas.width !== width ||
            session.canvas.height !== height
          ) {
            session.canvas.width = width;
            session.canvas.height = height;
          }
          session.context.drawImage(bitmap, 0, 0);
          bitmap.close();
        } catch (e) {
          this.logger.warn("Failed to decode screen share frame", e);
        }
      }
    } finally {
      session.decoding = false;
    }
  }

  private async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.stopped = true;
    this.logger.info("Stopping native screen share");

    try {
      session.ws.close();
    } catch {
      // Socket may already be dead.
    }

    if (session.published) {
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
    session.videoTrack.stop();
    session.audioTrack?.stop();
    session.workletNode?.disconnect();
    if (session.audioContext) {
      await session.audioContext
        .close()
        .catch((e) => this.logger.warn("Failed to close audio context", e));
    }
    session.canvas.remove();
    this.sendStatus(false);
  }
}
