/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  AudioPresets,
  LocalAudioTrack,
  Track,
  type LocalParticipant,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from "livekit-client";
import { type Logger } from "matrix-js-sdk/lib/logger";
import { type IWidgetApiRequest } from "matrix-widget-api";

import { type Behavior } from "../../Behavior.ts";
import { ElementWidgetActions, widget } from "../../../widget.ts";
import { getUrlParams } from "../../../UrlParams.ts";

/**
 * Linux app-audio screen share bridge (Tauri host, CEF/Chromium).
 *
 * Chromium's getDisplayMedia on Linux can only capture whole-system
 * loopback audio — there is no per-application audio like Windows'
 * process loopback. The widget always uses that native loopback
 * capture; the isolation happens host-side, behind Chromium's back:
 * the host finds the loopback capture stream in PipeWire, unlinks it
 * from the speaker monitor and feeds it only the selected apps (or
 * everything minus Sable in "system" mode). Chromium believes it
 * captures desktop audio and needs no cooperation. (A venmic-style
 * virtual microphone does not work here: CEF never exposes real audio
 * input devices through enumerateDevices.)
 *
 * Video comes in two flavours, chosen by the host's picker:
 *  - "screen" (default): the normal getDisplayMedia portal flow —
 *    the system dialog offers screens/regions (CEF hardcodes a
 *    TYPE_SCREEN DesktopMediaID when no device id is given).
 *  - "window": getUserMedia with the legacy CEF/Electron
 *    chromeMediaSource:'desktop' constraint and a `window:` device id,
 *    which makes WebRTC create a *window* capturer — the portal dialog
 *    then lists application windows, so a single app can be shared.
 *
 * Flow per share:
 *  1. widget → host: app_audio_request (host shows its audio picker)
 *  2. host → widget: app_audio_select ({ audio, videoSurface? })
 *     (the host arms its PipeWire routing before replying)
 *  3. widget: capture video + loopback audio, publish both
 *  4. widget → host: app_audio_stopped when the share ends (either
 *     direction), so the host tears the PipeWire routing down
 */

/** Host's answer to an app_audio_request. */
export interface AppAudioSelectPayload {
  /**
   * - virtual: capture loopback audio; the host rewires it to the
   *   user's selection behind the scenes
   * - browser: plain browser share (host routing unavailable)
   * - none: share without audio
   * - cancelled: user dismissed the picker; abort the share
   */
  audio: "virtual" | "browser" | "none" | "cancelled";
  /** Historical (virtual-microphone era); no longer used. */
  deviceLabel?: string;
  /**
   * Which capture surface the portal dialog should offer. "window"
   * lists application windows (per-app video); "screen"/absent keeps
   * the default screens/regions dialog.
   */
  videoSurface?: "window" | "screen";
}

/** Guards against a lost host reply keeping the toggle stuck forever. */
const SELECTION_TIMEOUT_MS = 5 * 60_000;

/** How long the one-shot capture level probe listens. */
const LEVEL_PROBE_MS = 3000;

/** When to sample the audio RTP sender after publishing. */
const SENDER_STATS_SAMPLES_MS = [5000, 15000];

/**
 * Whether the hosting client provides host-routed screen share audio via
 * the io.sable.screen_share.app_audio_* widget actions.
 */
export function isAppAudioShareMode(): boolean {
  const { screenShareAppAudio, hideScreensharing } = getUrlParams();
  return widget !== null && screenShareAppAudio === true && !hideScreensharing;
}

export class AppAudioShareManager {
  /**
   * Audio track we published ourselves (window-surface shares); the
   * screen-surface share's audio is managed by setScreenShareEnabled.
   */
  private audioTrack: MediaStreamTrack | null = null;

  /** LiveKit wrapper of the published audio track, for sender stats. */
  private publishedAudioTrack: LocalAudioTrack | null = null;

  /**
   * Video track we published ourselves (window-surface shares go through
   * getUserMedia + publishTrack instead of setScreenShareEnabled).
   */
  private manualVideoTrack: MediaStreamTrack | null = null;

  /** The share's video track, watched for browser-initiated stops. */
  private watchedVideoTrack: MediaStreamTrack | null = null;

  private diagnosticsTimers: number[] = [];

  private readonly onVideoEnded = (): void => {
    this.logger.info("Screen share video track ended (browser side)");
    void this.cleanup();
  };

  /** Serializes toggles; a click during startup/teardown is dropped. */
  private busy = false;

  private readonly logger: Logger;

  public constructor(
    private readonly participant$: Behavior<LocalParticipant | null>,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.getChild("[AppAudioShare]");
  }

  public toggle(
    targetState: boolean,
    settings: ScreenShareCaptureOptions,
    publishOptions?: TrackPublishOptions,
  ): void {
    if (this.busy) {
      this.logger.info("Ignoring screen share toggle while one is in flight");
      return;
    }
    this.busy = true;
    void (targetState ? this.start(settings, publishOptions) : this.stop())
      .catch((e) => {
        this.logger.error("Screen share toggle failed", e);
        // The host may have routing up for a share that never started.
        void this.cleanup();
      })
      .finally(() => {
        this.busy = false;
      });
  }

  public dispose(): void {
    void this.cleanup();
  }

  private async start(
    settings: ScreenShareCaptureOptions,
    publishOptions?: TrackPublishOptions,
  ): Promise<void> {
    const participant = this.participant$.value;
    if (!participant) return;

    const selection = await this.requestSelection();
    this.logger.info(
      `Host selected screen share audio: ${selection.audio}` +
        ` (videoSurface=${selection.videoSurface ?? "screen"})`,
    );
    if (selection.audio === "cancelled") return;
    const wantAudio = selection.audio !== "none";

    let videoTrack: MediaStreamTrack;
    let audioTrack: MediaStreamTrack | null = null;
    if (selection.videoSurface === "window") {
      try {
        ({ videoTrack, audioTrack } = await this.startWindowCapture(
          participant,
          settings,
          wantAudio,
          publishOptions,
        ));
      } catch (e) {
        // Portal dialog dismissed or capture failed; release host routing.
        this.notifyStopped();
        throw e;
      }
    } else {
      const captureOptions: ScreenShareCaptureOptions = { ...settings };
      if (!wantAudio) {
        captureOptions.audio = false;
        captureOptions.systemAudio = "exclude";
      } else if (selection.audio === "virtual") {
        // Native loopback capture; the host rewires what flows into it.
        // Raw audio: voice processing would mangle media content, and
        // echo cancellation would duck it against the call.
        captureOptions.audio = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        captureOptions.systemAudio = "include";
      }

      try {
        await participant.setScreenShareEnabled(
          true,
          captureOptions,
          publishOptions,
        );
      } catch (e) {
        this.notifyStopped();
        throw e;
      }

      const videoPublication = participant.getTrackPublication(
        Track.Source.ScreenShare,
      );
      if (!videoPublication?.track) {
        // No track despite no exception (e.g. toggle raced): treat as
        // stopped so the host does not keep routing forever.
        this.notifyStopped();
        return;
      }
      videoTrack = videoPublication.track.mediaStreamTrack;

      const audioPublication = participant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      );
      if (audioPublication?.track instanceof LocalAudioTrack) {
        this.publishedAudioTrack = audioPublication.track;
        audioTrack = audioPublication.track.mediaStreamTrack;
      } else if (wantAudio) {
        this.logger.error(
          "Screen share produced no loopback audio track; sharing video only",
        );
      }
    }

    // Chromium's own "Stop sharing" bar ends the track without going
    // through our toggle; that must still tear the host routing down.
    this.watchedVideoTrack = videoTrack;
    this.watchedVideoTrack.addEventListener("ended", this.onVideoEnded);

    if (audioTrack) {
      this.logger.info(
        `Captured share audio: label="${audioTrack.label}" ` +
          `settings=${JSON.stringify(audioTrack.getSettings())}`,
      );
      this.startAudioDiagnostics(audioTrack);
    }
  }

  /**
   * Captures a single application window through the desktop portal and
   * publishes it as the ScreenShare track, optionally with loopback
   * audio (which the host may rewire).
   *
   * CEF's getDisplayMedia path hardcodes full-screen capture (the portal
   * dialog then only offers screens/regions), but its getUserMedia
   * handler parses chromeMediaSourceId as a DesktopMediaID — a
   * `window:` id creates a WebRTC *window* capturer, and on Wayland the
   * portal dialog lists application windows. The numeric ids are
   * placeholders: the portal makes the actual choice.
   */
  private async startWindowCapture(
    participant: LocalParticipant,
    settings: ScreenShareCaptureOptions,
    wantAudio: boolean,
    publishOptions?: TrackPublishOptions,
  ): Promise<{
    videoTrack: MediaStreamTrack;
    audioTrack: MediaStreamTrack | null;
  }> {
    const resolution = settings.resolution;
    const videoConstraints = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: "window:0:0",
        maxWidth: resolution?.width ?? 3840,
        maxHeight: resolution?.height ?? 2160,
        maxFrameRate: resolution?.frameRate ?? 30,
      },
      // The legacy desktop-capture constraint syntax has no TS type.
    } as MediaTrackConstraints;
    const audioConstraints = {
      mandatory: { chromeMediaSource: "desktop" },
    } as MediaTrackConstraints;

    let stream: MediaStream;
    if (wantAudio) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: videoConstraints,
        });
      } catch (e) {
        this.logger.warn(
          "Window capture with loopback audio failed; retrying video-only",
          e,
        );
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints,
        });
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints,
      });
    }

    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error("Window capture produced no video track");
    }
    try {
      // Screen content wants detail preserved over smooth motion.
      track.contentHint = "detail";
    } catch {
      // Advisory only.
    }

    this.manualVideoTrack = track;
    try {
      await participant.publishTrack(track, {
        ...publishOptions,
        source: Track.Source.ScreenShare,
      });
    } catch (e) {
      this.manualVideoTrack = null;
      for (const t of stream.getTracks()) t.stop();
      throw e;
    }
    this.logger.info("Published window-surface screen share video track");

    let audioTrack: MediaStreamTrack | null = stream.getAudioTracks()[0] ?? null;
    if (audioTrack) {
      this.audioTrack = audioTrack;
      try {
        const publication = await participant.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio,
          dtx: false,
          red: false,
          // Mirrors the native bridge: without this, stereo system audio
          // can downmix to mono when channelCount is not reported.
          forceStereo: true,
          audioPreset: AudioPresets.musicStereo,
        });
        if (publication.track instanceof LocalAudioTrack) {
          this.publishedAudioTrack = publication.track;
        }
        this.logger.info("Published window-surface share audio track");
      } catch (e) {
        // Audio is best-effort: keep the video share alive.
        this.logger.error("Failed to publish window share audio track", e);
        this.audioTrack = null;
        audioTrack.stop();
        audioTrack = null;
      }
    } else if (wantAudio) {
      this.logger.error(
        "Window capture produced no loopback audio track; sharing video only",
      );
    }

    return { videoTrack: track, audioTrack };
  }

  private async stop(): Promise<void> {
    const participant = this.participant$.value;
    const manual = this.manualVideoTrack;
    this.manualVideoTrack = null;
    if (participant) {
      if (manual) {
        await participant
          .unpublishTrack(manual, true)
          .catch((e) =>
            this.logger.error("Failed to unpublish share video track", e),
          );
      } else {
        await participant.setScreenShareEnabled(false);
      }
    }
    manual?.stop();
    await this.cleanup();
  }

  /** Idempotent teardown: unpublish audio, unhook the watcher, tell the host. */
  private async cleanup(): Promise<void> {
    if (this.watchedVideoTrack) {
      this.watchedVideoTrack.removeEventListener("ended", this.onVideoEnded);
      this.watchedVideoTrack = null;
    }

    for (const timer of this.diagnosticsTimers) clearTimeout(timer);
    this.diagnosticsTimers = [];
    this.publishedAudioTrack = null;

    const participant = this.participant$.value;

    // Window-surface video that ended browser-side (portal "stop" or the
    // window closing) still has a publication to remove.
    const manual = this.manualVideoTrack;
    this.manualVideoTrack = null;
    if (manual) {
      if (participant) {
        await participant
          .unpublishTrack(manual, true)
          .catch((e) =>
            this.logger.error("Failed to unpublish share video track", e),
          );
      }
      manual.stop();
    }

    const audioTrack = this.audioTrack;
    this.audioTrack = null;
    if (audioTrack) {
      if (participant) {
        await participant
          .unpublishTrack(audioTrack, true)
          .catch((e) =>
            this.logger.error("Failed to unpublish share audio track", e),
          );
      }
      audioTrack.stop();
    }

    this.notifyStopped();
  }

  /**
   * Asks the host which audio to attach. The host shows its picker, so
   * this can legitimately take as long as the user thinks about it.
   */
  private async requestSelection(): Promise<AppAudioSelectPayload> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (selection: AppAudioSelectPayload): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        widget?.lazyActions.off(
          ElementWidgetActions.ScreenShareAppAudioSelect,
          onSelect,
        );
        resolve(selection);
      };

      const onSelect = (ev: CustomEvent<IWidgetApiRequest>): void => {
        widget?.api.transport.reply(ev.detail, {});
        settle(ev.detail.data as unknown as AppAudioSelectPayload);
      };

      const timeout = setTimeout(() => {
        this.logger.error("Host never answered the app audio request");
        settle({ audio: "cancelled" });
      }, SELECTION_TIMEOUT_MS);

      widget?.lazyActions.on(
        ElementWidgetActions.ScreenShareAppAudioSelect,
        onSelect,
      );
      widget?.api.transport
        .send(ElementWidgetActions.ScreenShareAppAudioRequest, {})
        .catch((e) => {
          this.logger.error("Failed to send app audio request", e);
          // Host unreachable: behave like a plain browser share.
          settle({ audio: "browser" });
        });
    });
  }

  private notifyStopped(): void {
    widget?.api.transport
      .send(ElementWidgetActions.ScreenShareAppAudioStopped, {})
      .catch((e) => {
        this.logger.error("Failed to notify host of share stop", e);
      });
  }

  /**
   * One-shot post-publish diagnostics: a short capture-level probe (is
   * the loopback capture actually delivering samples?) and RTP sender
   * samples (is encoded audio leaving this client?). Together they
   * split "PipeWire routing silent" from "publish/negotiation broken".
   */
  private startAudioDiagnostics(track: MediaStreamTrack): void {
    void this.probeCaptureLevel(track);
    for (const delayMs of SENDER_STATS_SAMPLES_MS) {
      const timer = window.setTimeout(() => {
        void this.logAudioSenderStats(delayMs);
      }, delayMs);
      this.diagnosticsTimers.push(timer);
    }
  }

  private async probeCaptureLevel(track: MediaStreamTrack): Promise<void> {
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const buf = new Float32Array(analyser.fftSize);
      let sumSquares = 0;
      let samples = 0;
      let peak = 0;
      const started = performance.now();
      while (
        performance.now() - started < LEVEL_PROBE_MS &&
        track.readyState === "live"
      ) {
        analyser.getFloatTimeDomainData(buf);
        for (const v of buf) {
          sumSquares += v * v;
          peak = Math.max(peak, Math.abs(v));
        }
        samples += buf.length;
        await new Promise((r) => setTimeout(r, 100));
      }
      const rms = Math.sqrt(sumSquares / Math.max(samples, 1));
      this.logger.info(
        `Share audio capture level over ${LEVEL_PROBE_MS}ms: ` +
          `rms=${rms.toFixed(5)} peak=${peak.toFixed(5)}` +
          (peak < 0.0001
            ? " — SILENT: the loopback capture is delivering no audio"
            : ""),
      );
    } catch (e) {
      this.logger.warn("Share audio level probe failed", e);
    } finally {
      void ctx?.close().catch(() => {});
    }
  }

  private async logAudioSenderStats(atMs: number): Promise<void> {
    const track = this.publishedAudioTrack;
    if (!track) return;
    try {
      const stats = await track.getSenderStats();
      if (!stats) {
        this.logger.warn(`Share audio sender stats at ${atMs}ms: unavailable`);
        return;
      }
      this.logger.info(
        `Share audio sender at ${atMs}ms: packetsSent=${stats.packetsSent ?? "?"} ` +
          `bytesSent=${stats.bytesSent ?? "?"} packetsLost=${stats.packetsLost ?? "?"}` +
          (stats.packetsSent === 0
            ? " — NOT SENDING: publish negotiation likely failed"
            : ""),
      );
    } catch (e) {
      this.logger.warn(`Share audio sender stats at ${atMs}ms failed`, e);
    }
  }

}
