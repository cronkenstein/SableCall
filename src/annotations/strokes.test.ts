/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  STROKE_FADE_MS,
  STROKE_HOLD_MS,
  StrokeStore,
  decodeSegment,
  encodeSegment,
  strokeColour,
  strokeOpacity,
} from "./strokes";

const ALICE = "@alice:example.org:DEVICE";
const BOB = "@bob:example.org:DEVICE";

function segment(
  n: number,
  points: [number, number][],
  finished = false,
  shareKey = BOB,
): ReturnType<typeof decodeSegment> {
  return decodeSegment(
    encodeSegment(
      shareKey,
      "stroke-1",
      n,
      points.map(([x, y]) => ({ x, y })),
      finished,
    ),
  );
}

describe("stroke segments", () => {
  it("survive the wire, rounded to the grid", () => {
    const decoded = segment(3, [
      [0.12345, 0.5],
      [1, 0],
    ]);
    expect(decoded).toEqual({
      v: 1,
      s: BOB,
      k: "stroke-1",
      n: 3,
      p: [1235, 5000, 10000, 0],
    });
  });

  it("clamp points off the picture onto its edge", () => {
    expect(segment(0, [[-0.5, 2]])?.p).toEqual([0, 10000]);
  });

  it("mark the last segment", () => {
    expect(segment(0, [[0.5, 0.5]], true)?.e).toBe(1);
  });

  it.each([
    ["not JSON", new TextEncoder().encode("not json")],
    [
      "the wrong version",
      new TextEncoder().encode('{"v":2,"s":"a","k":"b","n":0,"p":[]}'),
    ],
    [
      "an odd number of coordinates",
      new TextEncoder().encode('{"v":1,"s":"a","k":"b","n":0,"p":[1]}'),
    ],
    [
      "a negative segment",
      new TextEncoder().encode('{"v":1,"s":"a","k":"b","n":-1,"p":[]}'),
    ],
    [
      "non-numbers",
      new TextEncoder().encode('{"v":1,"s":"a","k":"b","n":0,"p":["x",1]}'),
    ],
  ])("refuse %s", (_label, payload) => {
    expect(decodeSegment(payload)).toBeNull();
  });
});

describe("StrokeStore", () => {
  it("builds a stroke from its segments, in order of arrival", () => {
    const store = new StrokeStore();
    store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0);
    store.apply(
      ALICE,
      segment(1, [
        [0.2, 0.2],
        [0.3, 0.3],
      ])!,
      10,
    );
    const [stroke] = store.visible(BOB, 10);
    expect(stroke.points).toHaveLength(3);
    expect(stroke.sender).toBe(ALICE);
  });

  it("draws a segment delivered twice only once", () => {
    const store = new StrokeStore();
    expect(store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0)).toBe(true);
    expect(store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0)).toBe(false);
    expect(store.visible(BOB, 0)[0].points).toHaveLength(1);
  });

  it("keeps two people's strokes with the same id apart", () => {
    const store = new StrokeStore();
    store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0);
    store.apply(BOB, segment(0, [[0.9, 0.9]])!, 0);
    expect(store.visible(BOB, 0)).toHaveLength(2);
  });

  it("only shows strokes on the share they were drawn on", () => {
    const store = new StrokeStore();
    store.apply(ALICE, segment(0, [[0.1, 0.1]], false, "share-a")!, 0);
    expect(store.visible("share-a", 0)).toHaveLength(1);
    expect(store.visible("share-b", 0)).toHaveLength(0);
  });

  it("holds a finished stroke, fades it, then forgets it", () => {
    const store = new StrokeStore();
    store.apply(ALICE, segment(0, [[0.1, 0.1]], true)!, 1000);
    const [stroke] = store.visible(BOB, 1000);

    expect(strokeOpacity(stroke, 1000 + STROKE_HOLD_MS)).toBe(1);
    expect(
      strokeOpacity(stroke, 1000 + STROKE_HOLD_MS + STROKE_FADE_MS / 2),
    ).toBeCloseTo(0.5);
    expect(
      store.visible(BOB, 1000 + STROKE_HOLD_MS + STROKE_FADE_MS),
    ).toHaveLength(0);
    expect(store.sweep(1000 + STROKE_HOLD_MS + STROKE_FADE_MS)).toBe(false);
  });

  it("keeps a stroke being drawn at full strength", () => {
    const store = new StrokeStore();
    store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0);
    expect(strokeOpacity(store.visible(BOB, 0)[0], STROKE_HOLD_MS * 1.5)).toBe(
      1,
    );
  });

  it("lets a stroke whose sender went quiet fade like a finished one", () => {
    const store = new StrokeStore();
    store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0);
    store.sweep(STROKE_HOLD_MS * 2 + 1);
    const [stroke] = store.visible(BOB, STROKE_HOLD_MS * 2 + 1);
    expect(stroke.finished).toBe(true);
  });

  it("tells subscribers about changes", () => {
    const store = new StrokeStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.apply(ALICE, segment(0, [[0.1, 0.1]])!, 0);
    unsubscribe();
    store.apply(ALICE, segment(1, [[0.2, 0.2]])!, 0);
    expect(calls).toBe(1);
  });
});

describe("strokeColour", () => {
  it("gives the same person the same colour every time", () => {
    expect(strokeColour(ALICE)).toBe(strokeColour(ALICE));
    expect(strokeColour(ALICE)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
