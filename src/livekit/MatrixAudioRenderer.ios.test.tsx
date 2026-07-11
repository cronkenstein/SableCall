/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, type RenderResult } from "@testing-library/react";
import {
  getTrackReferenceId,
  type TrackReference,
} from "@livekit/components-core";
import { type Participant, type RemoteAudioTrack, type Room } from "livekit-client";
import { forwardRef } from "react";
import { useTracks } from "@livekit/components-react";

import { testAudioContext } from "../useAudioContext.test";
import * as MediaDevicesContext from "../MediaDevicesContext";
import { LivekitRoomAudioRenderer } from "./MatrixAudioRenderer";
import {
  mockMediaDevices,
  mockRemoteParticipant,
  mockTrack,
} from "../utils/test";
import { initializeWidget } from "../widget";
initializeWidget();

// Everything in this file runs as if on an iPhone: the web audio graph must
// terminate in a MediaStreamAudioDestinationNode played by a dedicated
// <audio> element (see routeGraphThroughMediaElement).
vi.mock("../Platform", () => ({
  platform: "ios",
  isFirefox: (): boolean => false,
}));

const TestAudioContextConstructor = vi.fn(
  class {
    public constructor() {
      return testAudioContext;
    }
  },
);

const MediaDevicesProvider = MediaDevicesContext.MediaDevicesContext.Provider;

beforeEach(() => {
  vi.stubGlobal("AudioContext", TestAudioContextConstructor);
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(
    undefined,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

vi.mock("@livekit/components-react", async (importOriginal) => {
  return {
    ...(await importOriginal()),
    AudioTrack: forwardRef<HTMLAudioElement, { trackRef: TrackReference }>(
      function AudioTrack(props, ref) {
        return (
          <audio ref={ref} data-testid={"audio"}>
            {getTrackReferenceId(props.trackRef)}
          </audio>
        );
      },
    ),
    useTracks: vi.fn(),
  };
});

let tracks: TrackReference[] = [];

function renderTestComponent(): RenderResult {
  const participant = mockRemoteParticipant({ identity: "@alice:DEV0" });
  const livekitRoom = {
    remoteParticipants: new Map<string, Participant>([
      [participant.identity, participant],
    ]),
  } as unknown as Room;
  tracks = [mockTrack(participant)];
  vi.mocked(useTracks).mockReturnValue(tracks);
  return render(
    <MediaDevicesProvider value={mockMediaDevices({})}>
      <LivekitRoomAudioRenderer
        validIdentities={[participant.identity]}
        livekitRoom={livekitRoom}
        url={""}
      />
    </MediaDevicesProvider>,
  );
}

it("terminates the web audio graph in a media element instead of the context destination", () => {
  const { getByTestId } = renderTestComponent();

  // livekit must have been handed a context whose destination is the
  // MediaStreamAudioDestinationNode, so its per-track volume gain node (the
  // volume slider) ends up upstream of the processed element.
  const audioTrack = tracks[0].publication.track! as RemoteAudioTrack;
  expect(audioTrack.setAudioContext).toHaveBeenCalled();
  const facade = vi.mocked(audioTrack.setAudioContext).mock
    .lastCall![0] as AudioContext;
  expect(testAudioContext.createMediaStreamDestination).toHaveBeenCalled();
  const mediaDest =
    testAudioContext.createMediaStreamDestination.mock.results[0].value;
  expect(facade.destination).toBe(mediaDest);

  // The processed element must play the graph's output stream.
  const processed = getByTestId("processed-audio") as HTMLAudioElement;
  expect(processed.srcObject).toBe(mediaDest.stream);
  expect(processed.muted).toBe(false);
});

it("keeps the raw audio element muted and restarts the processed element on unmute attempts", () => {
  const { getByTestId } = renderTestComponent();
  const raw = getByTestId("audio") as HTMLAudioElement;
  const processed = getByTestId("processed-audio") as HTMLAudioElement;

  // The element playing the raw track is muted as soon as web audio routing
  // is active; only the processed element may sound.
  expect(raw.muted).toBe(true);

  // Room.startAudio() and remote unmute handling set element.muted = false
  // behind our back; the browser fires "volumechange" for that, which must
  // re-assert the mute (otherwise WKWebView plays the raw track at full
  // volume alongside the web audio graph) and use the playback-allowed
  // context to restart the processed element.
  const playSpy = vi.spyOn(processed, "play").mockResolvedValue(undefined);
  raw.muted = false;
  raw.dispatchEvent(new Event("volumechange"));
  expect(raw.muted).toBe(true);
  expect(playSpy).toHaveBeenCalled();
});
