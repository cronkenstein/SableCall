/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { getTrackReferenceId } from "@livekit/components-core";
import { type Room as LivekitRoom } from "livekit-client";
import { type RemoteAudioTrack, Track } from "livekit-client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useTracks,
  AudioTrack,
  type AudioTrackProps,
} from "@livekit/components-react";
import { logger } from "matrix-js-sdk/lib/logger";

import { useEarpieceAudioConfig } from "../MediaDevicesContext";
import { platform } from "../Platform";
import { useReactiveState } from "../useReactiveState";
import * as controls from "../controls";

export interface MatrixAudioRendererProps {
  /**
   * The service URL of the LiveKit room.
   */
  url: string;
  livekitRoom: LivekitRoom;
  /**
   * The list of participant identities to render audio for.
   * This list needs to be composed based on the matrixRTC members so that we do not play audio from users
   * that are not expected to be in the rtc session (local user is excluded).
   */
  validIdentities: string[];
  /**
   * If set to `true`, mutes all audio tracks rendered by the component.
   * @remarks
   * If set to `true`, the server will stop sending audio track data to the client.
   */
  muted?: boolean;
}

const prefixedLogger = logger.getChild("[MatrixAudioRenderer]");

function shouldRouteAudioThroughWebContext(stereoPan: number): boolean {
  if (stereoPan !== 0) return true;
  // WKWebView ignores HTMLMediaElement.volume. Route mobile remote audio through
  // LiveKit's per-track gain nodes so screenshare volume controls work.
  return platform !== "desktop";
}

// On iOS, sound played through AudioContext.destination is tied to the audio
// session in ways that HTMLMediaElement playback is not: WebKit treats Web
// Audio output like a sound effect, so it can be silenced by the ringer
// switch or when the session is not held open by an audibly playing media
// element, while <audio> playback always sounds. So on iOS the web audio
// graph must terminate in a MediaStreamAudioDestinationNode whose stream is
// played by a dedicated <audio> element, not in the context's destination.
const routeGraphThroughMediaElement = platform === "ios";

/**
 * Takes care of handling remote participants’ audio tracks and makes sure that microphones and screen share are audible.
 *
 * It also takes care of the earpiece audio configuration for iOS devices.
 * This is done by using the WebAudio API to create a stereo pan effect that mimics the earpiece audio.
 * @example
 * ```tsx
 * <LiveKitRoom>
 *   <MatrixAudioRenderer />
 * </LiveKitRoom>
 * ```
 * @public
 */
export function LivekitRoomAudioRenderer({
  url,
  livekitRoom,
  validIdentities,
  muted,
}: MatrixAudioRendererProps): ReactNode {
  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: true,
      room: livekitRoom,
    },
  )
    // Only keep audio tracks
    .filter((ref) => ref.publication.kind === Track.Kind.Audio)
    // Only keep tracks from participants that are in the validIdentities list
    .filter((ref) => {
      const isValid = validIdentities.includes(ref.participant.identity);
      if (!isValid) {
        // TODO make sure to also skip the warn logging for the local identity
        // Log that there is an invalid identity, that means that someone is publishing audio that is not expected to be in the call.
        prefixedLogger.warn(
          `Audio track ${ref.participant.identity} from ${url} has no matching matrix call member`,
          `current members: ${validIdentities.join()}`,
          `track will not get rendered`,
        );
        return false;
      }
      return true;
    });

  // This component is also (in addition to the "only play audio for connected members" logic above)
  // responsible for mimicking earpiece audio on iPhones.
  // The Safari audio devices enumeration does not expose an earpiece audio device.
  // We alternatively use the audioContext pan node to only use one of the stereo channels.

  // This component does get additionally complicated because of a Safari bug.
  // (see: https://bugs.webkit.org/show_bug.cgi?id=251532
  // and the related issues: https://bugs.webkit.org/show_bug.cgi?id=237878
  // and https://bugs.webkit.org/show_bug.cgi?id=231105)
  //
  // AudioContext gets stopped if the webview gets moved into the background.
  // Once the phone is in standby audio playback will stop.
  // So we can only use the pan trick only works is the phone is not in standby.
  // If earpiece mode is not used we normally skip audioContext to allow standby playback.
  // On mobile we still route through audioContext so per-track gain (screenshare volume) works.

  const { pan: stereoPan, volume: volumeFactor } = useEarpieceAudioConfig();
  const shouldUseAudioContext = shouldRouteAudioThroughWebContext(stereoPan);

  // initialize the potentially used audio context.
  const [audioContext, setAudioContext] = useState<AudioContext | undefined>(
    undefined,
  );
  useEffect(() => {
    const ctx = new AudioContext();
    setAudioContext(ctx);
    return (): void => {
      void ctx.close();
    };
  }, []);

  return (
    // We add all audio elements into one <div> for the browser developer tool experience/tidyness.
    <div style={{ display: "none" }}>
      {tracks.map((trackRef) => (
        <AudioTrackWithAudioNodes
          key={getTrackReferenceId(trackRef)}
          trackRef={trackRef}
          muted={muted}
          audioContext={shouldUseAudioContext ? audioContext : undefined}
          stereoPan={stereoPan}
          volumeFactor={volumeFactor}
        />
      ))}
    </div>
  );
}

interface StereoPanAudioTrackProps {
  muted?: boolean;
  audioContext?: AudioContext;
  stereoPan: number;
  volumeFactor: number;
}

/**
 * This wraps `livekit.AudioTrack` to allow adding audio nodes to a track.
 * It main purpose is to remount the AudioTrack component when switching from
 * audioContext to normal audio playback.
 * As of now the AudioTrack component does not support adding audio nodes while being mounted.
 * @param props The component props
 * @param props.trackRef The track reference
 * @param props.muted If the track should be muted
 * @param props.audioContext The audio context to use
 * @param props.stereoPan The earpiece stereo pan to apply to this track
 * @param props.volumeFactor The earpiece volume factor to apply to this track
 * @returns
 */
function AudioTrackWithAudioNodes({
  trackRef,
  muted,
  audioContext,
  stereoPan,
  volumeFactor,
  ...props
}: StereoPanAudioTrackProps &
  AudioTrackProps &
  React.RefAttributes<HTMLAudioElement>): ReactNode {
  // The earpiece gain/pan nodes are per track: on iOS every track terminates
  // in its own MediaStreamAudioDestinationNode (see
  // routeGraphThroughMediaElement), so tracks cannot share graph nodes
  // without mixing into each other's sinks.
  const audioNodes = useMemo(
    () =>
      audioContext && {
        gain: audioContext.createGain(),
        pan: audioContext.createStereoPanner(),
        mediaDest: routeGraphThroughMediaElement
          ? audioContext.createMediaStreamDestination()
          : undefined,
      },
    [audioContext],
  );

  // Simple effects to update the gain and pan node based on the props
  useEffect(() => {
    if (audioNodes) audioNodes.pan.pan.value = stereoPan;
  }, [audioNodes, stereoPan]);
  useEffect(() => {
    if (audioNodes) audioNodes.gain.gain.value = volumeFactor;
  }, [audioNodes, volumeFactor]);

  // livekit-client connects its per-track volume gain node (the one driven by
  // participant.setVolume, i.e. the volume slider) straight to
  // `context.destination`. To terminate the graph in our
  // MediaStreamAudioDestinationNode instead, hand livekit a facade of the
  // context whose `destination` is that node.
  const trackAudioContext = useMemo(() => {
    if (!audioContext || !audioNodes?.mediaDest) return audioContext;
    const { mediaDest } = audioNodes;
    return new Proxy(audioContext, {
      get(target, prop): unknown {
        if (prop === "destination") return mediaDest;
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }, [audioContext, audioNodes]);

  // This is used to unmount/remount the AudioTrack component.
  // Mounting needs to happen after the audioContext is set.
  // (adding the audio context when already mounted did not work outside strict mode)
  const [trackReady, setTrackReady] = useReactiveState(
    () => false,
    // We only want the track to reset once both (audioNodes and audioContext) are set.
    // for unsetting the audioContext its enough if one of the two is undefined.
    [audioContext && audioNodes],
  );

  const audioEl = useRef<HTMLAudioElement | null>(null);
  const processedAudioEl = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!trackRef || trackReady) return;
    const track = trackRef.publication.track as RemoteAudioTrack;
    const useContext = (audioContext && audioNodes) || undefined;
    track.setAudioContext(useContext && trackAudioContext);
    track.setWebAudioPlugins(
      useContext ? [audioNodes!.gain, audioNodes!.pan] : [],
    );
    setTrackReady(true);
    controls.setPlaybackStarted();
  }, [
    audioContext,
    audioNodes,
    trackAudioContext,
    setTrackReady,
    trackReady,
    trackRef,
  ]);

  // While the track is routed through the audio context, the <audio> element
  // livekit attached the raw track to must stay muted: livekit mutes it when
  // connecting web audio, but Room.startAudio() (triggered by
  // AudioStreamAcquired and visibility changes) and remote unmute handling
  // set element.muted = false again. Chrome keeps the element silent anyway
  // via the element.volume = 0 that livekit leaves behind, but WKWebView
  // ignores element volume, so an unmuted element plays the raw track at full
  // volume on top of the web audio graph — doubling the audio and bypassing
  // the gain node that the volume slider controls. Setting `muted` fires
  // "volumechange", so we can re-assert the mute whenever something lifts it.
  //
  // On iOS the graph's output plays through a second <audio> element (see
  // routeGraphThroughMediaElement), managed here as well. Room.startAudio()
  // runs in contexts where playback is allowed (user gesture, visibility
  // regained), so the "volumechange" it causes on the raw element doubles as
  // our cue to (re)start the processed element.
  useEffect(() => {
    const raw = audioEl.current;
    if (!raw || !audioNodes || !trackReady) return;

    const playProcessed = (): void => {
      const processed = processedAudioEl.current;
      const mediaDest = audioNodes.mediaDest;
      if (!processed || !mediaDest) return;
      if (processed.srcObject !== mediaDest.stream)
        processed.srcObject = mediaDest.stream;
      if (processed.paused) {
        try {
          const playPromise = processed.play() as Promise<void> | undefined;
          playPromise?.catch((e) => {
            prefixedLogger.warn("Could not start processed audio playback", e);
          });
        } catch (e) {
          prefixedLogger.warn("Could not start processed audio playback", e);
        }
      }
    };

    const onVolumeChange = (): void => {
      if (!raw.muted) raw.muted = true;
      playProcessed();
    };
    onVolumeChange();
    raw.addEventListener("volumechange", onVolumeChange);
    return (): void => raw.removeEventListener("volumechange", onVolumeChange);
  }, [audioNodes, trackReady]);

  // Diagnostics for the iOS audio pipeline: periodically log whether audio
  // energy is flowing through the graph and what state the sinks are in, so
  // rageshakes can distinguish "graph gets no input" from "output not
  // audible".
  useEffect(() => {
    if (!audioContext || !audioNodes?.mediaDest || !trackReady) return;
    if (!("createAnalyser" in audioContext)) return;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioNodes.pan.connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    const trackId = trackRef && getTrackReferenceId(trackRef);
    const log = (): void => {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128));
      const raw = audioEl.current;
      const processed = processedAudioEl.current;
      prefixedLogger.debug(
        `audio pipeline (${trackId}): context=${audioContext.state}`,
        `graphPeak=${peak}`,
        `raw(muted=${raw?.muted} paused=${raw?.paused})`,
        `processed(muted=${processed?.muted} paused=${processed?.paused})`,
      );
    };
    const timeout = setTimeout(log, 3000);
    const interval = setInterval(log, 30000);
    return (): void => {
      clearTimeout(timeout);
      clearInterval(interval);
      analyser.disconnect();
    };
  }, [audioContext, audioNodes, trackReady, trackRef]);

  return (
    trackReady && (
      <>
        <AudioTrack
          trackRef={trackRef}
          muted={muted}
          {...props}
          ref={audioEl}
        />
        {audioNodes?.mediaDest && (
          <audio ref={processedAudioEl} autoPlay data-testid="processed-audio" />
        )}
      </>
    )
  );
}
