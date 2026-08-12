/*
Copyright 2023, 2024 New Vector Ltd.
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  observeParticipantEvents,
  observeParticipantMedia,
  type TrackReference,
} from "@livekit/components-core";
import { ParticipantEvent, type Participant, type Track } from "livekit-client";
import { distinctUntilChanged, map, merge, type Observable } from "rxjs";

/**
 * Reactively reads a participant's track reference for a given media source.
 *
 * Two things here are load-bearing, and both were previously missing, which
 * left remote video stuck on the last state the UI happened to observe: a
 * screen share that stayed blank while its audio played, and a stream that
 * never came back after picture-in-picture closed. Neither recovered on its
 * own, because nothing downstream was ever told the track had arrived.
 */
export function observeTrackReference$(
  participant: Participant,
  source: Track.Source,
): Observable<TrackReference | undefined> {
  return merge(
    observeParticipantMedia(participant),
    // observeParticipantMedia covers publish/unpublish and mute, but NOT
    // subscription: it carries TrackSubscriptionStatusChanged, which reports
    // the status we *asked* for, and nothing for the track actually arriving.
    // Publication precedes subscription, so without these the first emission
    // describes a publication with no track and no later one corrects it.
    //
    // Deliberately NOT TrackStreamStateChanged. adaptiveStream flips
    // streamState as elements come in and out of view, and the network
    // adapts, but a pause leaves the track object and the element's binding
    // intact — frames just stop and resume. Emitting there makes consumers
    // re-attach the track for no reason, which shows up as choppy video and
    // can strand a frozen frame. When adaptiveStream really does unsubscribe,
    // TrackUnsubscribed fires and the track identity changes, which the
    // comparison below already catches.
    observeParticipantEvents(
      participant,
      ParticipantEvent.TrackSubscribed,
      ParticipantEvent.TrackUnsubscribed,
    ),
  ).pipe(
    // Snapshot the track alongside the publication. LiveKit fills in
    // publication.track by mutating the existing object, so comparing
    // `previous.track` to `current.track` would read the same live field
    // twice and always agree — the very aliasing that made a plain
    // distinctUntilChanged swallow the arrival of media. Capturing the value
    // at emission time is what makes the change visible.
    map(() => {
      const publication = participant.getTrackPublication(source);
      return {
        publication,
        track: publication?.track,
      };
    }),
    distinctUntilChanged(
      (previous, current) =>
        previous.publication === current.publication &&
        previous.track === current.track,
    ),
    map(
      ({ publication }) => publication && { participant, publication, source },
    ),
  );
}
