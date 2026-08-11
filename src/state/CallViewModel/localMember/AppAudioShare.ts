/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  AudioPresets,
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
 * process loopback. The hosting client closes that gap with PipeWire:
 * it routes only the selected applications' streams into a virtual
 * source ("sable-screen-share"), which this widget captures like a
 * microphone and publishes as the ScreenShareAudio track. Video is
 * untouched: the normal getDisplayMedia portal flow, so E2EE, publish
 * options and room lifecycle stay identical to a plain browser share.
 *
 * Flow per share:
 *  1. widget → host: app_audio_request (host shows its audio picker)
 *  2. host → widget: app_audio_select ({ audio, deviceLabel? })
 *  3. widget: getDisplayMedia video (browser portal picker), then
 *     capture + publish the virtual device when audio === "virtual"
 *  4. widget → host: app_audio_stopped when the share ends (either
 *     direction), so the host tears the PipeWire routing down
 */

/** Host's answer to an app_audio_request. */
export interface AppAudioSelectPayload {
  /**
   * - virtual: capture the PipeWire device labelled `deviceLabel`
   * - browser: fall back to Chromium's own systemAudio capture
   * - none: share without audio
   * - cancelled: user dismissed the picker; abort the share
   */
  audio: "virtual" | "browser" | "none" | "cancelled";
  deviceLabel?: string;
}

/** Guards against a lost host reply keeping the toggle stuck forever. */
const SELECTION_TIMEOUT_MS = 5 * 60_000;

/** The virtual source can lag device enumeration by a moment. */
const DEVICE_POLL_INTERVAL_MS = 250;
const DEVICE_POLL_ATTEMPTS = 20;

/**
 * Whether the hosting client provides host-routed screen share audio via
 * the io.sable.screen_share.app_audio_* widget actions.
 */
export function isAppAudioShareMode(): boolean {
  const { screenShareAppAudio, hideScreensharing } = getUrlParams();
  return widget !== null && screenShareAppAudio === true && !hideScreensharing;
}

export class AppAudioShareManager {
  /** Published virtual-device audio track for the active share. */
  private audioTrack: MediaStreamTrack | null = null;

  /** The share's video track, watched for browser-initiated stops. */
  private watchedVideoTrack: MediaStreamTrack | null = null;

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
    this.logger.info(`Host selected screen share audio: ${selection.audio}`);
    if (selection.audio === "cancelled") return;

    const captureOptions: ScreenShareCaptureOptions = { ...settings };
    if (selection.audio !== "browser") {
      // Audio comes from the virtual device (or not at all); don't let
      // the browser offer/capture its whole-system loopback on top.
      captureOptions.audio = false;
      captureOptions.systemAudio = "exclude";
    }

    try {
      await participant.setScreenShareEnabled(
        true,
        captureOptions,
        publishOptions,
      );
    } catch (e) {
      // Portal dialog dismissed or capture failed; release host routing.
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

    // Chromium's own "Stop sharing" bar ends the track without going
    // through our toggle; that must still tear the host routing down.
    this.watchedVideoTrack = videoPublication.track.mediaStreamTrack;
    this.watchedVideoTrack.addEventListener("ended", this.onVideoEnded);

    if (selection.audio === "virtual" && selection.deviceLabel) {
      try {
        await this.publishVirtualAudio(participant, selection.deviceLabel);
      } catch (e) {
        // Audio is best-effort: keep the video share alive, like the
        // native path does when its audio pipeline fails.
        this.logger.error(
          "Failed to capture host-routed share audio; sharing video only",
          e,
        );
      }
    }
  }

  private async stop(): Promise<void> {
    const participant = this.participant$.value;
    if (participant) {
      await participant.setScreenShareEnabled(false);
    }
    await this.cleanup();
  }

  /** Idempotent teardown: unpublish audio, unhook the watcher, tell the host. */
  private async cleanup(): Promise<void> {
    if (this.watchedVideoTrack) {
      this.watchedVideoTrack.removeEventListener("ended", this.onVideoEnded);
      this.watchedVideoTrack = null;
    }

    const audioTrack = this.audioTrack;
    this.audioTrack = null;
    if (audioTrack) {
      const participant = this.participant$.value;
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

  private async publishVirtualAudio(
    participant: LocalParticipant,
    deviceLabel: string,
  ): Promise<void> {
    const deviceId = await this.findDevice(deviceLabel);
    if (!deviceId) {
      throw new Error(
        `Virtual audio device "${deviceLabel}" never appeared in enumerateDevices`,
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        // Raw share audio: any voice processing would mangle media
        // content, and echo cancellation would duck it against the call.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("Virtual device produced no audio track");

    this.audioTrack = track;
    await participant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      red: false,
      // Mirrors the native bridge: without this, stereo system audio
      // can downmix to mono when channelCount is not reported.
      forceStereo: true,
      audioPreset: AudioPresets.musicStereo,
    });
    this.logger.info("Published host-routed share audio track");
  }

  /** The PipeWire node can lag Chromium's device list; poll briefly. */
  private async findDevice(label: string): Promise<string | null> {
    for (let attempt = 0; attempt < DEVICE_POLL_ATTEMPTS; attempt++) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const device = devices.find(
        (d) => d.kind === "audioinput" && d.label.includes(label),
      );
      if (device) return device.deviceId;
      await new Promise((r) => setTimeout(r, DEVICE_POLL_INTERVAL_MS));
    }
    return null;
  }
}
