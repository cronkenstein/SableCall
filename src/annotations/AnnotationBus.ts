/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  ConnectionState,
  RoomEvent,
  type RemoteParticipant,
  type Room as LivekitRoom,
} from "livekit-client";
import { logger } from "matrix-js-sdk/lib/logger";

import {
  ANNOTATION_TOPIC,
  StrokeStore,
  decodeSegment,
  encodeSegment,
  strokeColour,
  type Point,
} from "./strokes";

/** How often the points of a stroke being drawn are sent. */
const SEND_INTERVAL_MS = 40;
/** How often faded strokes are cleared away while any are left. */
const SWEEP_INTERVAL_MS = 250;

/** A stroke the local user is drawing. */
export interface LocalStroke {
  addPoint(point: Point): void;
  finish(): void;
}

/**
 * Carries strokes between everyone in the call, over LiveKit's data channel —
 * encrypted along with the media in an encrypted call.
 *
 * A stroke goes out on every room the call is connected to, so it reaches
 * everyone however the call is spread across SFUs; anyone connected to more
 * than one gets it more than once, and the store drops the repeats.
 */
/** A drawing segment as the host overlay expects it. */
export interface DrawingSegmentForHost {
  sender: string;
  colour: string;
  stroke: string;
  segment: number;
  /** Flat x, y pairs, each 0..10000 across the shared picture. */
  points: number[];
  last: boolean;
}

export class AnnotationBus {
  public readonly store = new StrokeStore();
  /** Called for every segment applied to the store (local or remote), so the
   *  host can forward it to the drawing overlay on the sharer's screen. */
  public onSegment: ((segment: DrawingSegmentForHost) => void) | undefined;
  private readonly rooms = new Map<LivekitRoom, () => void>();
  private nextStroke = 0;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private warnedSendFailure = false;

  /** Follows the rooms the call is connected to. */
  public setRooms(rooms: LivekitRoom[]): void {
    for (const [room, unsubscribe] of this.rooms) {
      if (!rooms.includes(room)) {
        unsubscribe();
        this.rooms.delete(room);
      }
    }
    for (const room of rooms) {
      if (this.rooms.has(room)) continue;
      const onData = (
        payload: Uint8Array,
        participant?: RemoteParticipant,
        _kind?: unknown,
        topic?: string,
      ): void => {
        if (topic !== ANNOTATION_TOPIC || !participant) return;
        const segment = decodeSegment(payload);
        if (!segment) return;
        if (
          this.store.apply(participant.identity, segment, performance.now())
        ) {
          this.startSweeping();
          this.onSegment?.({
            sender: participant.identity,
            colour: strokeColour(participant.identity),
            stroke: segment.k,
            segment: segment.n,
            points: segment.p,
            last: segment.e === 1,
          });
        }
      };
      room.on(RoomEvent.DataReceived, onData);
      this.rooms.set(room, () => room.off(RoomEvent.DataReceived, onData));
    }
  }

  /** Who the local user is to everyone else, if the call is connected. */
  public localIdentity(): string | undefined {
    for (const room of this.rooms.keys()) {
      const identity = room.localParticipant?.identity;
      if (identity) return identity;
    }
    return undefined;
  }

  /**
   * Starts a stroke on `shareKey`'s screen share. It is drawn locally at once
   * and sent in short runs while it is being drawn.
   */
  public beginStroke(shareKey: string): LocalStroke | null {
    const sender = this.localIdentity();
    if (!sender) return null;
    const strokeId = `${Date.now().toString(36)}-${(this.nextStroke++).toString(36)}`;
    let segment = 0;
    let pending: Point[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    const flush = (last: boolean): void => {
      timer = undefined;
      if (pending.length === 0 && !last) return;
      const payload = encodeSegment(shareKey, strokeId, segment, pending, last);
      segment += 1;
      pending = [];
      const decoded = decodeSegment(payload);
      if (decoded) {
        this.store.apply(sender, decoded, performance.now());
        this.onSegment?.({
          sender,
          colour: strokeColour(sender),
          stroke: decoded.k,
          segment: decoded.n,
          points: decoded.p,
          last: decoded.e === 1,
        });
      }
      this.startSweeping();
      this.publish(payload);
    };

    return {
      addPoint: (point: Point): void => {
        if (finished) return;
        pending.push(point);
        // The first point goes straight away, so the stroke shows the moment it starts.
        if (segment === 0 && pending.length === 1) flush(false);
        else timer ??= setTimeout(() => flush(false), SEND_INTERVAL_MS);
      },
      finish: (): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        flush(true);
      },
    };
  }

  public dispose(): void {
    for (const unsubscribe of this.rooms.values()) unsubscribe();
    this.rooms.clear();
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.store.clear();
  }

  private publish(payload: Uint8Array<ArrayBuffer>): void {
    for (const room of this.rooms.keys()) {
      if (room.state !== ConnectionState.Connected) continue;
      room.localParticipant
        .publishData(payload, { reliable: true, topic: ANNOTATION_TOPIC })
        .catch((e: unknown) => {
          if (this.warnedSendFailure) return;
          this.warnedSendFailure = true;
          logger.warn("Could not send a screen share annotation", e);
        });
    }
  }

  private startSweeping(): void {
    if (this.sweepTimer !== undefined) return;
    this.sweepTimer = setInterval(() => {
      if (!this.store.sweep(performance.now())) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
      }
    }, SWEEP_INTERVAL_MS);
  }
}
