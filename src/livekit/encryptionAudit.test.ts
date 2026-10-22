/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { Track } from "livekit-client";

import {
  judgeEncryption,
  type ParticipantReport,
  type RoomEncryptionReport,
  type TrackReport,
} from "./encryptionAudit";

const track = (overrides: Partial<TrackReport>): TrackReport => ({
  source: Track.Source.Microphone,
  kind: Track.Kind.Audio,
  sid: "TR_1",
  encrypted: true,
  muted: false,
  subscribed: true,
  ...overrides,
});

const mic = (
  wire: TrackReport["wire"],
  overrides: Partial<TrackReport> = {},
): TrackReport => track({ wire, ...overrides });

const share = (
  wire: TrackReport["wire"],
  overrides: Partial<TrackReport> = {},
): TrackReport =>
  track({
    source: Track.Source.ScreenShare,
    kind: Track.Kind.Video,
    sid: "TR_2",
    wire,
    ...overrides,
  });

const room = (
  remote: ParticipantReport[],
  overrides: Partial<RoomEncryptionReport> = {},
): RoomEncryptionReport => ({
  room: "#1",
  connection: "connected",
  encryptedCall: true,
  encrypting: true,
  local: { identity: "@me:hs:DEV", tracks: [] },
  remote,
  ...overrides,
});

/** `decrypting` is left unset only when the test asks for "unknown". */
const sharer = (
  tracks: TrackReport[],
  decrypting: boolean | "unknown" = true,
): ParticipantReport => ({
  identity: "@sharer:hs:DEV",
  decrypting: decrypting === "unknown" ? undefined : decrypting,
  tracks,
});

const texts = (rooms: RoomEncryptionReport[]): string[] =>
  judgeEncryption(rooms).map((v) => `${v.level}: ${v.text}`);

describe("judgeEncryption", () => {
  it("calls a share that decodes while decrypting encrypted", () => {
    const verdicts = texts([
      room([sharer([share({ bytes: 90_000, framesDecoded: 45 })])]),
    ]);
    expect(verdicts).toEqual([
      "ok: room #1: @sharer:hs:DEV's screen_share decrypts with their key, so it is encrypted",
    ]);
  });

  it("explains a working share beside silent audio as a receiver not decrypting", () => {
    // The reported symptom: the share is advertised unencrypted, so the
    // receiver stops decrypting this sender, and the encrypted microphone
    // reaches the decoder as ciphertext.
    const verdicts = texts([
      room([
        sharer(
          [
            mic({ bytes: 6_000, samplesDecoded: 72_000 }),
            share({ bytes: 90_000, framesDecoded: 45 }, { encrypted: false }),
          ],
          false,
        ),
      ]),
    ]);
    expect(verdicts).toEqual([
      "bad: room #1: @sharer:hs:DEV's screen_share is published UNENCRYPTED",
      "bad: room #1: NOT decrypting @sharer:hs:DEV: their media reaches the decoders as it arrives, so whatever plays from them proves nothing",
    ]);
  });

  it("names a wrong or missing key when bytes arrive and nothing decodes", () => {
    const verdicts = texts([
      room([
        sharer([
          mic({ bytes: 6_000, samplesDecoded: 0, samplesConcealed: 72_000 }),
        ]),
      ]),
    ]);
    expect(verdicts).toEqual([
      "bad: room #1: @sharer:hs:DEV's microphone arrives but nothing decodes: wrong or missing key",
    ]);
  });

  it("skips muted and unsubscribed tracks", () => {
    const verdicts = texts([
      room([
        sharer([
          mic({ bytes: 0 }, { muted: true }),
          share({ bytes: 0 }, { subscribed: false }),
        ]),
      ]),
    ]);
    expect(verdicts).toEqual([]);
  });

  it("flags our own unencrypted sending", () => {
    const verdicts = texts([
      room([], {
        encrypting: false,
        local: {
          identity: "@me:hs:DEV",
          tracks: [share(undefined, { encrypted: false })],
        },
      }),
    ]);
    expect(verdicts).toEqual([
      "bad: room #1: we are NOT encrypting what we send",
      "bad: room #1: our screen_share is published UNENCRYPTED",
    ]);
  });

  it("leaves out a room that never connected, and waits for one connecting", () => {
    // Seen on a real call: a room made and never used, with no identity and
    // no tracks, read as "we are NOT encrypting what we send".
    const unused = room([], {
      room: "#1",
      connection: "disconnected",
      encrypting: false,
      local: { identity: "", tracks: [] },
    });
    expect(texts([unused])).toEqual([]);
    expect(
      texts([room([], { connection: "connecting", encrypting: false })]),
    ).toEqual(["warn: room #1: still connecting"]);
  });

  it("says so when the call is not encrypted at all", () => {
    expect(texts([room([], { encryptedCall: false })])).toEqual([
      "warn: room #1: not an encrypted call",
    ]);
  });

  it("waits for the worker before judging a sender", () => {
    expect(texts([room([sharer([mic({ bytes: 6_000 })], "unknown")])])).toEqual(
      ["warn: room #1: no decrypt state for @sharer:hs:DEV yet"],
    );
  });
});
