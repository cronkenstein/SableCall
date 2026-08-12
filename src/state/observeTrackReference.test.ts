/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import {
  ParticipantEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from "livekit-client";
import { type TrackReference } from "@livekit/components-core";

import { observeTrackReference$ } from "./observeTrackReference";
import { mockRemoteParticipant } from "../utils/test";

/**
 * A publication LiveKit can mutate in place, as it really does: subscribing
 * assigns `track` on the existing object rather than replacing it. That
 * detail is the whole point of these tests.
 */
function mockPublication(): RemoteTrackPublication {
  return {
    trackSid: "SC_screenshare",
    track: undefined,
  } as Partial<RemoteTrackPublication> as RemoteTrackPublication;
}

interface Harness {
  participant: RemoteParticipant;
  publication: RemoteTrackPublication;
  emissions: (TrackReference | undefined)[];
  emit: (event: ParticipantEvent) => void;
  stop: () => void;
}

function harness(source = Track.Source.ScreenShare): Harness {
  const publication = mockPublication();
  const participant = mockRemoteParticipant({
    getTrackPublication: () => publication,
  });
  const emissions: (TrackReference | undefined)[] = [];
  const subscription = observeTrackReference$(participant, source).subscribe(
    (reference) => emissions.push(reference),
  );
  return {
    participant,
    publication,
    emissions,
    emit: (event) =>
      (participant as unknown as { emit: (e: string) => void }).emit(event),
    stop: () => subscription.unsubscribe(),
  };
}

describe("observeTrackReference$", () => {
  it("emits the current publication on subscribe", () => {
    const h = harness();
    expect(h.emissions).toHaveLength(1);
    expect(h.emissions[0]?.publication).toBe(h.publication);
    h.stop();
  });

  it("emits again when the track arrives on the same publication", () => {
    // The regression this exists for. LiveKit publishes first and subscribes
    // moments later, assigning `track` to the object it already handed us. If
    // that second step does not reach the view model, the screen share is
    // rendered from a publication that had no media and stays blank — while
    // its audio, which takes a different path, plays normally.
    const h = harness();
    h.emit(ParticipantEvent.TrackPublished);
    const before = h.emissions.length;

    (h.publication as { track?: unknown }).track = { kind: "video" };
    h.emit(ParticipantEvent.TrackSubscribed);

    expect(h.emissions.length).toBeGreaterThan(before);
    expect(h.emissions.at(-1)?.publication.track).toBeDefined();
    h.stop();
  });

  it("emits when a track goes away again", () => {
    const h = harness();
    (h.publication as { track?: unknown }).track = { kind: "video" };
    h.emit(ParticipantEvent.TrackSubscribed);
    const before = h.emissions.length;

    (h.publication as { track?: unknown }).track = undefined;
    h.emit(ParticipantEvent.TrackUnsubscribed);

    expect(h.emissions.length).toBeGreaterThan(before);
    expect(h.emissions.at(-1)?.publication.track).toBeUndefined();
    h.stop();
  });

  it("emits when adaptive stream pauses and resumes a track", () => {
    // adaptiveStream is enabled, so a track whose element stops being visible
    // is paused and resumed later. It does that without replacing the track
    // object — streamState is the only thing that moves — so that field has
    // to be part of what we compare.
    const h = harness();
    const track = { kind: "video", streamState: "active" };
    (h.publication as { track?: unknown }).track = track;
    h.emit(ParticipantEvent.TrackSubscribed);
    const afterSubscribe = h.emissions.length;

    track.streamState = "paused";
    h.emit(ParticipantEvent.TrackStreamStateChanged);
    expect(h.emissions.length).toBeGreaterThan(afterSubscribe);

    const afterPause = h.emissions.length;
    track.streamState = "active";
    h.emit(ParticipantEvent.TrackStreamStateChanged);
    expect(h.emissions.length).toBeGreaterThan(afterPause);
    h.stop();
  });

  it("still suppresses events that change nothing", () => {
    // The dedupe is worth keeping: without it every mute toggle would push a
    // fresh reference and re-render the tile for no reason.
    const h = harness();
    (h.publication as { track?: unknown }).track = { kind: "video" };
    h.emit(ParticipantEvent.TrackSubscribed);
    const before = h.emissions.length;

    h.emit(ParticipantEvent.TrackMuted);
    h.emit(ParticipantEvent.TrackUnmuted);
    h.emit(ParticipantEvent.TrackPublished);

    expect(h.emissions).toHaveLength(before);
    h.stop();
  });

  it("hands out a fresh reference each time so consumers re-read it", () => {
    // The publication object is reused by LiveKit; if we passed the same
    // TrackReference through as well, a memoising consumer could skip the
    // update even after we correctly detected it.
    const h = harness();
    const first = h.emissions.at(-1);

    (h.publication as { track?: unknown }).track = { kind: "video" };
    h.emit(ParticipantEvent.TrackSubscribed);

    expect(h.emissions.at(-1)).not.toBe(first);
    h.stop();
  });

  it("emits undefined when the participant has no such publication", () => {
    const participant = mockRemoteParticipant({
      getTrackPublication: () => undefined,
    });
    const emissions: (TrackReference | undefined)[] = [];
    const subscription = observeTrackReference$(
      participant,
      Track.Source.ScreenShare,
    ).subscribe((reference) => emissions.push(reference));

    expect(emissions).toEqual([undefined]);
    subscription.unsubscribe();
  });
});
