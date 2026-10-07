/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Drawing on a screen share: the strokes, how they travel, and how long they
 * last. No DOM and no LiveKit here, so all of it can be tested on its own.
 *
 * Points are kept relative to the shared picture itself (0–1 across its width
 * and height, wherever and however large it is drawn), so a stroke lands on
 * the same spot of the shared screen for everyone.
 */

/** The LiveKit data topic strokes travel on. */
export const ANNOTATION_TOPIC = "sable.annotation";

/** How long a stroke stays fully visible after its last point. */
export const STROKE_HOLD_MS = 2500;
/** How long it then takes to fade away. */
export const STROKE_FADE_MS = 800;

/** Points per stroke beyond which more are dropped: a guard, not a feature. */
const MAX_POINTS_PER_STROKE = 4000;
/** Strokes kept at once, oldest dropped first. */
const MAX_STROKES = 300;
/** Coordinates travel as integers in 0..COORD_SCALE. */
const COORD_SCALE = 10000;

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  /** Unique across senders: the sender's identity and their stroke id. */
  key: string;
  /** Whose screen share it is drawn on. */
  shareKey: string;
  /** Who drew it. */
  sender: string;
  points: Point[];
  /** When its last point arrived (or it was finished), local time. */
  lastAt: number;
  finished: boolean;
  /** Segments already applied, so a duplicate delivery is not drawn twice. */
  segments: Set<number>;
}

/** One message on the wire: a run of points added to a stroke. */
export interface StrokeSegment {
  v: 1;
  /** Share key. */
  s: string;
  /** The sender's id for the stroke. */
  k: string;
  /** Segment number within the stroke, from 0. */
  n: number;
  /** Points as flat integer pairs, x then y, each 0..COORD_SCALE. */
  p: number[];
  /** Present (1) on the stroke's last segment. */
  e?: 1;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function encodeSegment(
  shareKey: string,
  strokeId: string,
  segment: number,
  points: Point[],
  finished: boolean,
): Uint8Array<ArrayBuffer> {
  const flat: number[] = [];
  for (const { x, y } of points) {
    flat.push(
      Math.round(clamp01(x) * COORD_SCALE),
      Math.round(clamp01(y) * COORD_SCALE),
    );
  }
  const message: StrokeSegment = {
    v: 1,
    s: shareKey,
    k: strokeId,
    n: segment,
    p: flat,
    ...(finished ? { e: 1 as const } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(message));
}

/** Parses and checks a segment; anything malformed is null. */
export function decodeSegment(payload: Uint8Array): StrokeSegment | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Partial<StrokeSegment>;
  if (
    m.v !== 1 ||
    typeof m.s !== "string" ||
    typeof m.k !== "string" ||
    typeof m.n !== "number" ||
    !Number.isInteger(m.n) ||
    m.n < 0 ||
    !Array.isArray(m.p) ||
    m.p.length % 2 !== 0 ||
    !m.p.every((c) => typeof c === "number" && Number.isFinite(c))
  ) {
    return null;
  }
  return {
    v: 1,
    s: m.s,
    k: m.k,
    n: m.n,
    p: m.p,
    ...(m.e === 1 ? { e: 1 as const } : {}),
  };
}

function segmentPoints(flat: number[]): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    points.push({
      x: clamp01(flat[i] / COORD_SCALE),
      y: clamp01(flat[i + 1] / COORD_SCALE),
    });
  }
  return points;
}

/** How visible a stroke is at `now`: 1, fading towards 0, or 0 when gone. */
export function strokeOpacity(stroke: Stroke, now: number): number {
  if (!stroke.finished) return 1;
  const age = now - stroke.lastAt;
  if (age <= STROKE_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - STROKE_HOLD_MS) / STROKE_FADE_MS);
}

/**
 * Everyone's strokes, as they arrive. Strokes that are never finished — the
 * sender left mid-stroke — still fade, counted from their last point.
 */
export class StrokeStore {
  private readonly strokes = new Map<string, Stroke>();
  private readonly listeners = new Set<() => void>();

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Applies one segment from `sender`. Returns whether anything changed. */
  public apply(sender: string, segment: StrokeSegment, now: number): boolean {
    const key = `${sender}\u0000${segment.k}`;
    let stroke = this.strokes.get(key);
    if (!stroke) {
      stroke = {
        key,
        shareKey: segment.s,
        sender,
        points: [],
        lastAt: now,
        finished: false,
        segments: new Set(),
      };
      this.strokes.set(key, stroke);
      this.prune();
    }
    if (stroke.segments.has(segment.n)) return false;
    stroke.segments.add(segment.n);

    const room = MAX_POINTS_PER_STROKE - stroke.points.length;
    if (room > 0)
      stroke.points.push(...segmentPoints(segment.p).slice(0, room));
    stroke.lastAt = now;
    if (segment.e === 1) stroke.finished = true;
    this.notify();
    return true;
  }

  /** The strokes on one share still worth drawing at `now`. */
  public visible(shareKey: string, now: number): Stroke[] {
    const result: Stroke[] = [];
    for (const stroke of this.strokes.values()) {
      if (stroke.shareKey === shareKey && strokeOpacity(stroke, now) > 0) {
        result.push(stroke);
      }
    }
    return result;
  }

  /**
   * Drops strokes that have faded, and marks strokes whose sender went quiet
   * as finished so they fade too. Returns whether any stroke is left at all.
   */
  public sweep(now: number, staleAfterMs = STROKE_HOLD_MS * 2): boolean {
    let changed = false;
    for (const [key, stroke] of this.strokes) {
      if (!stroke.finished && now - stroke.lastAt > staleAfterMs) {
        // Fade from now, rather than vanish for having gone quiet long ago.
        stroke.finished = true;
        stroke.lastAt = now - STROKE_HOLD_MS;
        changed = true;
      }
      if (stroke.finished && strokeOpacity(stroke, now) === 0) {
        this.strokes.delete(key);
        changed = true;
      }
    }
    if (changed) this.notify();
    return this.strokes.size > 0;
  }

  public clear(): void {
    if (this.strokes.size === 0) return;
    this.strokes.clear();
    this.notify();
  }

  private prune(): void {
    while (this.strokes.size > MAX_STROKES) {
      const oldest = this.strokes.keys().next().value;
      if (oldest === undefined) return;
      this.strokes.delete(oldest);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** A colour per person, the same for everyone who sees the stroke. */
const STROKE_COLOURS = [
  "#ff5c5c",
  "#ffb02e",
  "#ffe14d",
  "#4cd97b",
  "#3fc8ff",
  "#6c8cff",
  "#c77dff",
  "#ff6fb5",
];

export function strokeColour(sender: string): string {
  let hash = 0;
  for (let i = 0; i < sender.length; i++) {
    hash = (hash * 31 + sender.charCodeAt(i)) | 0;
  }
  return STROKE_COLOURS[Math.abs(hash) % STROKE_COLOURS.length];
}
