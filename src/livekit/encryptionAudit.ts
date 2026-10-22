/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  RoomEvent,
  type LocalTrack,
  type RemoteTrack,
  type Room,
  type Track,
  type TrackPublication,
} from "livekit-client";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";

const logger = rootLogger.getChild("[EncryptionAudit]");

/*
 * Answers "is this call actually encrypted?" from inside the call, for every
 * LiveKit room it uses.
 *
 * LiveKit encrypts per participant, not per track: someone's microphone,
 * camera and screen share all go out under that person's key. A receiver also
 * decides per participant whether to decrypt at all, from the encryption each
 * of the sender's tracks advertises — every track published overwrites it —
 * and while it is off, frames reach the decoders exactly as they arrived. So a
 * single track advertised as unencrypted turns the rest of that sender's
 * encrypted media into ciphertext at the decoder (noise on WebKit, silence on
 * Chromium) while the unencrypted track itself plays.
 *
 * The receiver's own decrypt flag is therefore the reading that settles it.
 * While it is on, a track that decodes has passed AES-GCM authentication with
 * the sender's key, so it was encrypted; an unencrypted frame fails and is
 * dropped.
 */

/** About an hour of a busy call: a few entries per join, leave or share. */
const MAX_EVENTS = 300;
/** Gap between the two stats readings a report compares. */
const SAMPLE_GAP_MS = 1500;

export type AuditEvent = { at: number; room: string } & (
  | {
      kind: "published";
      identity: string;
      local: boolean;
      source: Track.Source;
      sid: string;
      encrypted: boolean;
    }
  | {
      /** The worker acknowledged decrypting (or, for us, encrypting) on or off. */
      kind: "decrypting";
      identity: string;
      local: boolean;
      enabled: boolean;
    }
  | { kind: "error"; identity?: string; message: string; count: number }
);

/** What moved on the wire between the report's two stats readings. */
export interface WireDelta {
  bytes: number;
  /** Video only. */
  framesDecoded?: number;
  framesEncoded?: number;
  /** Audio only: samples that came from real frames rather than concealment. */
  samplesDecoded?: number;
  samplesConcealed?: number;
}

export interface TrackReport {
  source: Track.Source;
  kind: Track.Kind;
  sid: string;
  /** What the sender advertised when publishing. */
  encrypted: boolean;
  muted: boolean;
  /** Remote tracks only: whether this client receives it. */
  subscribed?: boolean;
  wire?: WireDelta;
}

export interface ParticipantReport {
  identity: string;
  /**
   * Remote participants only: whether this client decrypts their media. Unset
   * until LiveKit's worker has acknowledged either way.
   */
  decrypting?: boolean;
  tracks: TrackReport[];
}

export interface RoomEncryptionReport {
  room: string;
  connection: string;
  /** Whether the room was set up with end-to-end encryption at all. */
  encryptedCall: boolean;
  /** Whether this client encrypts what it sends. */
  encrypting: boolean;
  local: ParticipantReport;
  remote: ParticipantReport[];
}

export interface Verdict {
  /** `bad` is a confirmed problem, `warn` an incomplete reading. */
  level: "ok" | "warn" | "bad";
  text: string;
}

export interface EncryptionReport {
  at: string;
  verdicts: Verdict[];
  rooms: RoomEncryptionReport[];
  events: AuditEvent[];
}

interface Watched {
  label: string;
  decrypting: Map<string, boolean>;
}

const events: AuditEvent[] = [];
const watched = new Map<Room, Watched>();
let nextRoomNumber = 1;

const push = (event: AuditEvent): void => {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
};

const isEncryptedCall = (room: Room): boolean =>
  Boolean(room.options.e2ee ?? room.options.encryption);

/**
 * Start recording a room's encryption state. Call it once, as the room is
 * created and before it connects, so no acknowledgement is missed.
 */
export function watchRoomEncryption(room: Room): void {
  if (watched.has(room)) return;
  const state: Watched = {
    label: `#${nextRoomNumber++}`,
    decrypting: new Map(),
  };
  watched.set(room, state);

  const published = (
    publication: TrackPublication,
    identity: string,
    local: boolean,
  ): void => {
    push({
      at: Date.now(),
      room: state.label,
      kind: "published",
      identity,
      local,
      source: publication.source,
      sid: publication.trackSid,
      encrypted: publication.isEncrypted,
    });
    if (isEncryptedCall(room) && !publication.isEncrypted) {
      logger.error(
        `${local ? "Our" : `${identity}'s`} ${publication.source} is published unencrypted in an encrypted call (room ${state.label})`,
      );
    }
  };

  room
    .on(RoomEvent.LocalTrackPublished, (publication, participant) =>
      published(publication, participant.identity, true),
    )
    .on(RoomEvent.TrackPublished, (publication, participant) =>
      published(publication, participant.identity, false),
    )
    .on(
      RoomEvent.ParticipantEncryptionStatusChanged,
      (enabled, participant) => {
        const local = !participant || participant.isLocal;
        const identity =
          participant?.identity ?? room.localParticipant.identity;
        if (!local) state.decrypting.set(identity, enabled);
        push({
          at: Date.now(),
          room: state.label,
          kind: "decrypting",
          identity,
          local,
          enabled,
        });
        if (isEncryptedCall(room) && !enabled) {
          logger.error(
            local
              ? `We are not encrypting what we send (room ${state.label})`
              : `Not decrypting ${identity}: their media reaches the decoders as it arrives (room ${state.label})`,
          );
        }
      },
    )
    .on(RoomEvent.EncryptionError, (error, participant) => {
      // LiveKit throttles these, but a broken key still repeats for as long as
      // it lasts: count repeats on the previous entry instead.
      const identity = participant?.identity;
      const last = events.at(-1);
      if (
        last?.kind === "error" &&
        last.room === state.label &&
        last.identity === identity &&
        last.message === error.message
      ) {
        last.count += 1;
        last.at = Date.now();
        return;
      }
      push({
        at: Date.now(),
        room: state.label,
        kind: "error",
        identity,
        message: error.message,
        count: 1,
      });
    })
    .once(RoomEvent.Disconnected, () => watched.delete(room));
}

type Counters = Omit<WireDelta, "bytes"> & { bytes: number };

const sum = (a: number | undefined, b: unknown): number | undefined =>
  typeof b === "number" ? (a ?? 0) + b : a;

/** Totals across a track's RTP streams (one per simulcast layer when sending). */
async function readCounters(
  publication: TrackPublication,
): Promise<Counters | undefined> {
  const track = publication.track as LocalTrack | RemoteTrack | undefined;
  if (!track) return undefined;
  let report: RTCStatsReport | undefined;
  try {
    report = await track.getRTCStatsReport();
  } catch {
    return undefined;
  }
  if (!report) return undefined;

  let counters: Counters | undefined;
  report.forEach((stat: Record<string, unknown>) => {
    if (stat.type !== "inbound-rtp" && stat.type !== "outbound-rtp") return;
    const c: Counters = counters ?? { bytes: 0 };
    c.bytes = sum(c.bytes, stat.bytesReceived ?? stat.bytesSent) ?? 0;
    c.framesDecoded = sum(c.framesDecoded, stat.framesDecoded);
    c.framesEncoded = sum(c.framesEncoded, stat.framesEncoded);
    if (typeof stat.totalSamplesReceived === "number") {
      const concealed =
        typeof stat.concealedSamples === "number" ? stat.concealedSamples : 0;
      c.samplesDecoded = sum(
        c.samplesDecoded,
        stat.totalSamplesReceived - concealed,
      );
      c.samplesConcealed = sum(c.samplesConcealed, concealed);
    }
    counters = c;
  });
  return counters;
}

const delta = (
  before: Counters | undefined,
  after: Counters | undefined,
): WireDelta | undefined => {
  if (!after) return undefined;
  const minus = (key: keyof Counters): number | undefined => {
    const end = after[key];
    return end === undefined ? undefined : end - (before?.[key] ?? 0);
  };
  return {
    bytes: minus("bytes") ?? 0,
    framesDecoded: minus("framesDecoded"),
    framesEncoded: minus("framesEncoded"),
    samplesDecoded: minus("samplesDecoded"),
    samplesConcealed: minus("samplesConcealed"),
  };
};

const trackBase = (
  publication: TrackPublication,
): Omit<TrackReport, "wire" | "subscribed"> => ({
  source: publication.source,
  kind: publication.kind,
  sid: publication.trackSid,
  encrypted: publication.isEncrypted,
  muted: publication.isMuted,
});

async function reportRooms(): Promise<RoomEncryptionReport[]> {
  const rooms = [...watched.entries()];
  const publications = rooms.flatMap(([room]) => [
    ...room.localParticipant.trackPublications.values(),
    ...[...room.remoteParticipants.values()].flatMap((p) => [
      ...p.trackPublications.values(),
    ]),
  ]);
  const read = async (): Promise<Map<TrackPublication, Counters>> => {
    const readings = await Promise.all(
      publications.map(async (p) => [p, await readCounters(p)] as const),
    );
    const map = new Map<TrackPublication, Counters>();
    for (const [p, c] of readings) if (c) map.set(p, c);
    return map;
  };
  const before = await read();
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_GAP_MS));
  const after = await read();
  const wire = (p: TrackPublication): WireDelta | undefined =>
    delta(before.get(p), after.get(p));

  return rooms.map(([room, state]) => ({
    room: room.name ? `${state.label} ${room.name}` : state.label,
    connection: room.state,
    encryptedCall: isEncryptedCall(room),
    encrypting: room.isE2EEEnabled,
    local: {
      identity: room.localParticipant.identity,
      tracks: [...room.localParticipant.trackPublications.values()].map(
        (p) => ({ ...trackBase(p), wire: wire(p) }),
      ),
    },
    remote: [...room.remoteParticipants.values()].map((participant) => ({
      identity: participant.identity,
      decrypting: state.decrypting.get(participant.identity),
      tracks: [...participant.trackPublications.values()].map((p) => ({
        ...trackBase(p),
        subscribed: p.isSubscribed,
        wire: wire(p),
      })),
    })),
  }));
}

const decodedNow = (track: TrackReport): boolean =>
  (track.wire?.framesDecoded ?? 0) > 0 || (track.wire?.samplesDecoded ?? 0) > 0;

/** Plain-language findings, room by room. */
export function judgeEncryption(rooms: RoomEncryptionReport[]): Verdict[] {
  const verdicts: Verdict[] = [];
  const say = (level: Verdict["level"], text: string): void => {
    verdicts.push({ level, text });
  };
  for (const room of rooms) {
    const at = `room ${room.room}`;
    // A room made and never connected (or already left) sends and receives
    // nothing: there is nothing to judge, and "not encrypting" would alarm.
    if (room.connection === "disconnected") continue;
    if (room.connection === "connecting") {
      say("warn", `${at}: still connecting`);
      continue;
    }
    if (!room.encryptedCall) {
      say("warn", `${at}: not an encrypted call`);
      continue;
    }
    if (!room.encrypting) {
      say("bad", `${at}: we are NOT encrypting what we send`);
    }
    for (const track of room.local.tracks) {
      if (!track.encrypted) {
        say("bad", `${at}: our ${track.source} is published UNENCRYPTED`);
      }
    }
    for (const participant of room.remote) {
      const who = participant.identity;
      for (const track of participant.tracks) {
        if (!track.encrypted) {
          say(
            "bad",
            `${at}: ${who}'s ${track.source} is published UNENCRYPTED`,
          );
        }
      }
      if (participant.decrypting === false) {
        say(
          "bad",
          `${at}: NOT decrypting ${who}: their media reaches the decoders as it arrives, so whatever plays from them proves nothing`,
        );
        continue;
      }
      if (participant.decrypting === undefined) {
        say("warn", `${at}: no decrypt state for ${who} yet`);
        continue;
      }
      for (const track of participant.tracks) {
        if (!track.subscribed || track.muted || !track.wire) continue;
        if (decodedNow(track)) {
          say(
            "ok",
            `${at}: ${who}'s ${track.source} decrypts with their key, so it is encrypted`,
          );
        } else if (track.wire.bytes > 0) {
          say(
            "bad",
            `${at}: ${who}'s ${track.source} arrives but nothing decodes: wrong or missing key`,
          );
        }
      }
    }
  }
  return verdicts;
}

/**
 * Everything known about this call's encryption, with verdicts. Takes about
 * 1.5 s: what is decoding is measured between two stats readings rather than
 * from totals since the start of the call.
 */
export async function getEncryptionReport(): Promise<EncryptionReport> {
  const rooms = await reportRooms();
  return {
    at: new Date().toISOString(),
    verdicts: judgeEncryption(rooms),
    rooms,
    events: [...events],
  };
}
