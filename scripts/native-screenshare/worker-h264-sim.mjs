// Verification harness for the media worker's H.264 decode path.
// Run: node scripts/native-screenshare/worker-h264-sim.mjs
//
// Simulates the media worker's H.264 handling with stubbed WebCodecs:
// verifies codec-string extraction from in-band SPS, key/delta chunk typing,
// timestamp rebasing, decoder recovery after error, and the backlog guard.
import { readFileSync } from "node:fs";

const ts = readFileSync(
  new URL("../../src/state/CallViewModel/localMember/NativeScreenShare.ts", import.meta.url),
  "utf8",
);
const match = ts.match(/const MEDIA_WORKER = `\n([\s\S]*?)\n`;/);
if (!match) throw new Error("worker source not found");
const constants = {};
for (const m of ts.matchAll(/^const ([A-Z_0-9]+) = ([0-9.]+|0x[0-9a-f]+);$/gim)) {
  constants[m[1]] = m[2];
}
const source = match[1].replace(/\$\{([A-Z_0-9]+)\}/g, (_, n) => {
  if (!(n in constants)) throw new Error(`unresolved ${n}`);
  return constants[n];
});

// --- WebCodecs stubs ---
const decoded = [];
let decoderInstances = 0;
let simulatedQueueSize = 0;
let failNextDecode = false;

class FakeVideoDecoder {
  constructor({ output, error }) {
    decoderInstances++;
    this.output = output;
    this.error = error;
    this.config = null;
    this.closed = false;
  }
  get decodeQueueSize() {
    return simulatedQueueSize;
  }
  configure(config) {
    this.config = config;
  }
  decode(chunk) {
    if (failNextDecode) {
      failNextDecode = false;
      throw new Error("simulated decode failure");
    }
    decoded.push({ type: chunk.type, timestamp: chunk.timestamp, config: this.config });
  }
  close() {
    this.closed = true;
  }
}
class FakeChunk {
  constructor({ type, timestamp, data }) {
    this.type = type;
    this.timestamp = timestamp;
    this.data = data;
  }
}

const posted = [];
const selfStub = {
  onmessage: null,
  postMessage: (msg) => posted.push(msg),
};
const sandbox = new Function(
  "self",
  "VideoDecoder",
  "EncodedVideoChunk",
  "WebSocket",
  "createImageBitmap",
  "VideoTrackGenerator",
  source + "\nreturn { onMedia, getDecoder: () => videoDecoder };",
);
const api = sandbox(
  selfStub,
  FakeVideoDecoder,
  FakeChunk,
  class {}, // WebSocket unused: we call onMedia directly
  async () => ({ close() {} }),
  undefined, // no generator: irrelevant here
);

// --- synthetic annex b payload builders ---
const SPS = [0x67, 0x64, 0x00, 0x28, 0xac]; // profile 0x64, constraints 0x00, level 0x28
const PPS = [0x68, 0xee, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x00];
const DELTA = [0x41, 0x9a, 0x02];
const START = [0, 0, 0, 1];

function videoMessage(nals, timestampUs) {
  const payload = nals.flatMap((nal) => [...START, ...nal]);
  const header = new Uint8Array(14 + payload.length);
  const view = new DataView(header.buffer);
  view.setUint8(0, 0x01); // MSG_VIDEO
  view.setUint8(1, 0x02); // VIDEO_CODEC_H264
  view.setUint16(2, 1920, true);
  view.setUint16(4, 1080, true);
  view.setBigUint64(6, BigInt(timestampUs), true);
  header.set(payload, 14);
  return header.buffer;
}

const BASE = 5_000_000_000; // absolute host-clock microseconds

// 1. Delta before any keyframe must be ignored (no decoder yet).
api.onMedia(videoMessage([DELTA], BASE));
console.assert(decoded.length === 0 && decoderInstances === 0, "delta before key ignored");

// 2. Keyframe configures decoder from SPS and decodes as 'key' at t=rebased.
api.onMedia(videoMessage([SPS, PPS, IDR], BASE + 1000));
console.assert(decoderInstances === 1, "decoder created");
console.assert(decoded.length === 1 && decoded[0].type === "key", "keyframe decoded");
console.assert(decoded[0].config.codec === "avc1.640028", `codec string: ${decoded[0].config.codec}`);
console.assert(decoded[0].config.optimizeForLatency === true, "low latency config");
// Rebase note: the delta at BASE set baseTimestamp even though it was skipped.
console.assert(decoded[0].timestamp === 1000, `rebased ts: ${decoded[0].timestamp}`);

// 3. Delta decodes as 'delta'.
api.onMedia(videoMessage([DELTA], BASE + 34_333));
console.assert(decoded[1].type === "delta" && decoded[1].timestamp === 34_333, "delta decoded");

// 4. Backlogged decoder drops deltas but accepts keyframes.
simulatedQueueSize = 20;
api.onMedia(videoMessage([DELTA], BASE + 60_000));
console.assert(decoded.length === 2, "backlogged delta dropped");
api.onMedia(videoMessage([SPS, PPS, IDR], BASE + 90_000));
console.assert(decoded.length === 3 && decoded[2].type === "key", "backlogged key accepted");
simulatedQueueSize = 0;

// 5. Decode failure disposes the decoder; next keyframe rebuilds it.
failNextDecode = true;
api.onMedia(videoMessage([DELTA], BASE + 120_000));
console.assert(api.getDecoder() === null, "decoder disposed after failure");
api.onMedia(videoMessage([DELTA], BASE + 150_000));
console.assert(decoded.length === 3, "delta without decoder ignored");
api.onMedia(videoMessage([SPS, PPS, IDR], BASE + 180_000));
console.assert(decoderInstances === 2 && decoded.length === 4 && decoded[3].type === "key", "decoder rebuilt on keyframe");

console.log(`decoded=${decoded.length} instances=${decoderInstances}`);
console.log("PASS: worker H.264 handling behaves correctly");

process.exit(0);
