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
    // TrackStreamStateChanged matters because adaptiveStream is on: it pauses
    // a track whose element stops being visible and resumes it afterwards,
    // which is how closing PiP could strand the video.
    observeParticipantEvents(
      participant,
      ParticipantEvent.TrackSubscribed,
      ParticipantEvent.TrackUnsubscribed,
      ParticipantEvent.TrackStreamStateChanged,
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
        // adaptiveStream pauses and resumes a track without replacing the
        // track object, so its streamState is the only thing that moves.
        streamState: publication?.track?.streamState,
      };
    }),
    distinctUntilChanged(
      (previous, current) =>
        previous.publication === current.publication &&
        previous.track === current.track &&
        previous.streamState === current.streamState,
    ),
    map(
      ({ publication }) => publication && { participant, publication, source },
    ),
  );
}
