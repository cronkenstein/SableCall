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
 * Keeps a small prebuffer to ride out network jitter and drops the oldest
 * chunks if the host outpaces playback.
 */
const AUDIO_SINK_WORKLET = `
class NativeScreenShareSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.readFrame = 0;
    this.queuedFrames = 0;
    this.started = false;
    // ~60ms prebuffer, ~1s overflow cap (sampleRate is a worklet global).
    this.prebufferFrames = Math.round(sampleRate * 0.06);
    this.maxQueuedFrames = sampleRate;
    this.port.onmessage = (event) => {
      const chunk = event.data;
      if (!chunk || !(chunk.samples instanceof Float32Array) || !chunk.channels) return;
      this.chunks.push(chunk);
      this.queuedFrames += chunk.samples.length / chunk.channels;
      while (this.queuedFrames > this.maxQueuedFrames && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        const droppedFrames = dropped.samples.length / dropped.channels - this.readFrame;
        this.readFrame = 0;
        this.queuedFrames -= droppedFrames;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frameCount = output[0].length;

    if (!this.started && this.queuedFrames < this.prebufferFrames) {
      return true; // emit silence until the prebuffer fills
    }
    this.started = true;

    for (let frame = 0; frame < frameCount; frame++) {
      const chunk = this.chunks[0];
      if (!chunk) {
        for (let ch = 0; ch < output.length; ch++) output[ch][frame] = 0;
        continue;
      }
      const channels = chunk.channels;
      const base = this.readFrame * channels;
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][frame] = chunk.samples[base + Math.min(ch, channels - 1)];
      }
      this.readFrame++;
      this.queuedFrames--;
      if (this.readFrame * channels >= chunk.samples.length) {
        this.chunks.shift();
        this.readFrame = 0;
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
        const samples = new Float32Array(
          buffer,
          AUDIO_HEADER_LEN,
          (buffer.byteLength - AUDIO_HEADER_LEN) >> 2,
        );
        session.workletNode.port.postMessage({ samples, channels }, [buffer]);
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
