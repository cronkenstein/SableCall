/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionState,
  RoomEvent,
  type Room as LivekitRoom,
} from "livekit-client";

import { AnnotationBus } from "./AnnotationBus";
import { pictureRect, toPicturePoint } from "./drawStrokes";
import { ANNOTATION_TOPIC, encodeSegment } from "./strokes";

type DataHandler = (
  payload: Uint8Array,
  participant?: { identity: string },
  kind?: unknown,
  topic?: string,
) => void;

function fakeRoom(identity: string): LivekitRoom & {
  receive: DataHandler;
  publishData: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<DataHandler>();
  const publishData = vi.fn().mockResolvedValue(undefined);
  const room = {
    state: ConnectionState.Connected,
    localParticipant: { identity, publishData },
    on: (event: string, handler: DataHandler): void => {
      if (event === RoomEvent.DataReceived) handlers.add(handler);
    },
    off: (event: string, handler: DataHandler): void => {
      if (event === RoomEvent.DataReceived) handlers.delete(handler);
    },
    receive: ((...args) => {
      for (const handler of handlers) handler(...args);
    }) as DataHandler,
    publishData,
  };
  return room as unknown as LivekitRoom & {
    receive: DataHandler;
    publishData: ReturnType<typeof vi.fn>;
  };
}

describe("AnnotationBus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("draws the local stroke at once and sends it as it grows", () => {
    const bus = new AnnotationBus();
    const room = fakeRoom("me");
    bus.setRooms([room]);

    const stroke = bus.beginStroke("sharer")!;
    stroke.addPoint({ x: 0.1, y: 0.1 });
    expect(bus.store.visible("sharer", performance.now())).toHaveLength(1);
    expect(room.publishData).toHaveBeenCalledTimes(1);

    stroke.addPoint({ x: 0.2, y: 0.2 });
    stroke.addPoint({ x: 0.3, y: 0.3 });
    vi.advanceTimersByTime(50);
    expect(room.publishData).toHaveBeenCalledTimes(2);

    stroke.finish();
    expect(room.publishData).toHaveBeenCalledTimes(3);
    const [, options] = room.publishData.mock.calls[2];
    expect(options).toEqual({ reliable: true, topic: ANNOTATION_TOPIC });
    const [drawn] = bus.store.visible("sharer", performance.now());
    expect(drawn.points).toHaveLength(3);
    expect(drawn.finished).toBe(true);
    bus.dispose();
  });

  it("shows other people's strokes, once, however many rooms bring them", () => {
    const bus = new AnnotationBus();
    const roomA = fakeRoom("me");
    const roomB = fakeRoom("me");
    bus.setRooms([roomA, roomB]);
    const payload = encodeSegment(
      "sharer",
      "s1",
      0,
      [{ x: 0.5, y: 0.5 }],
      true,
    );

    roomA.receive(payload, { identity: "them" }, undefined, ANNOTATION_TOPIC);
    roomB.receive(payload, { identity: "them" }, undefined, ANNOTATION_TOPIC);

    const strokes = bus.store.visible("sharer", performance.now());
    expect(strokes).toHaveLength(1);
    expect(strokes[0].points).toHaveLength(1);
    bus.dispose();
  });

  it("ignores other topics and anything it cannot read", () => {
    const bus = new AnnotationBus();
    const room = fakeRoom("me");
    bus.setRooms([room]);
    const payload = encodeSegment(
      "sharer",
      "s1",
      0,
      [{ x: 0.5, y: 0.5 }],
      true,
    );

    room.receive(payload, { identity: "them" }, undefined, "something.else");
    room.receive(
      new Uint8Array([1, 2, 3]),
      { identity: "them" },
      undefined,
      ANNOTATION_TOPIC,
    );

    expect(bus.store.visible("sharer", performance.now())).toHaveLength(0);
    bus.dispose();
  });

  it("stops listening to rooms the call has left", () => {
    const bus = new AnnotationBus();
    const room = fakeRoom("me");
    bus.setRooms([room]);
    bus.setRooms([]);
    room.receive(
      encodeSegment("sharer", "s1", 0, [{ x: 0.5, y: 0.5 }], true),
      { identity: "them" },
      undefined,
      ANNOTATION_TOPIC,
    );
    expect(bus.store.visible("sharer", performance.now())).toHaveLength(0);
  });

  it("does not start a stroke before the call is connected", () => {
    expect(new AnnotationBus().beginStroke("sharer")).toBeNull();
  });
});

describe("pictureRect", () => {
  it("letterboxes a wide picture in a tall element", () => {
    expect(pictureRect(400, 400, 1600, 900, "contain")).toEqual({
      x: 0,
      y: 87.5,
      width: 400,
      height: 225,
    });
  });

  it("crops it when covering", () => {
    const rect = pictureRect(400, 400, 1600, 900, "cover");
    expect(rect.height).toBe(400);
    expect(rect.x).toBeLessThan(0);
  });

  it("uses the whole element before the video has a size", () => {
    expect(pictureRect(300, 200, 0, 0, "contain")).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });
});

describe("toPicturePoint", () => {
  it("measures from the picture, not the element", () => {
    const rect = pictureRect(400, 400, 1600, 900, "contain");
    expect(toPicturePoint(rect, 200, 200)).toEqual({ x: 0.5, y: 0.5 });
    expect(toPicturePoint(rect, 0, 87.5)).toEqual({ x: 0, y: 0 });
  });
});
