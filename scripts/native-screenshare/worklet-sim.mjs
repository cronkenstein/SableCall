// Verification harness for the native screen share audio jitter buffer.
// Run: node scripts/native-screenshare/worklet-sim.mjs
// Extracts AUDIO_SINK_WORKLET from NativeScreenShare.ts and drives it through
// clock skew, sample-rate mismatch, stalls, and bursty (fullscreen-contention)
// delivery. Run this before and after tuning any jitter-buffer constant.
//
// Simulates the NativeScreenShareSink worklet against realistic clock
// scenarios, including the bursty delivery seen under fullscreen
// WindowServer contention. Asserts:
//  - steady-state latency returns to the 80ms budget on clean delivery;
//  - bursty delivery adapts (few underruns after warmup) instead of
//    stuttering indefinitely, with latency bounded by MAX_TARGET;
//  - pitch is preserved; discontinuities stay declicked.
import { readFileSync } from "node:fs";

const ts = readFileSync(
  new URL("../../src/state/CallViewModel/localMember/NativeScreenShare.ts", import.meta.url),
  "utf8",
);
const match = ts.match(/const AUDIO_SINK_WORKLET = `\n([\s\S]*?)`;/);
if (!match) throw new Error("worklet source not found");

const constants = {};
for (const m of ts.matchAll(/^const ([A-Z_0-9]+) = ([0-9.]+|0x[0-9a-f]+);$/gm)) {
  constants[m[1]] = m[2];
}
const workletSource = match[1].replace(/\$\{([A-Z_0-9]+)\}/g, (_, name) => {
  if (!(name in constants)) throw new Error(`unresolved constant ${name}`);
  return constants[name];
});

function makeSink(contextRate) {
  let SinkClass;
  const factory = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    workletSource,
  );
  factory(
    class {
      constructor() {
        this.port = { onmessage: null, postMessage: () => {} };
      }
    },
    (_name, cls) => {
      SinkClass = cls;
    },
    contextRate,
  );
  return new SinkClass();
}

function makeChunk(rate, frames, phaseRef, freq = 440) {
  const samples = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin(phaseRef.phase);
    phaseRef.phase += (2 * Math.PI * freq) / rate;
    samples[i * 2] = v;
    samples[i * 2 + 1] = v;
  }
  return { samples, channels: 2, rate };
}

function simulate({
  name,
  contextRate,
  chunkRate,
  producerSpeed = 1,
  seconds = 60,
  stallAt = null, // [startSec, durationSec] with burst delivery after
  burstEvery = null, // deliver chunks in clumps every N seconds
  expect,
}) {
  const sink = makeSink(contextRate);
  const chunkFrames = Math.round(chunkRate * 0.02);
  const phaseRef = { phase: 0 };
  const quantum = 128;

  let producerNext = 0;
  let pendingBurst = [];
  let burstDue = [];
  let burstNext = 0;
  let time = 0;
  const levels = [];
  let zeroCrossings = 0;
  let prevSample = 0;
  let maxJump = 0;
  let outputFrames = 0;
  let underruns = 0;
  let lateUnderruns = 0; // after 10s warmup

  while (time < seconds) {
    const wasStarted = sink.started;
    const output = [new Float32Array(quantum), new Float32Array(quantum)];
    sink.process([], [output]);
    if (wasStarted && !sink.started) {
      underruns++;
      if (time > 10) lateUnderruns++;
    }
    for (let i = 0; i < quantum; i++) {
      const v = output[0][i];
      if (prevSample <= 0 && v > 0) zeroCrossings++;
      const jump = Math.abs(v - prevSample);
      if (jump > maxJump) maxJump = jump;
      prevSample = v;
    }
    outputFrames += quantum;
    time += quantum / contextRate;

    while (producerNext <= time) {
      const chunk = makeChunk(chunkRate, chunkFrames, phaseRef);
      const stalled =
        stallAt && producerNext >= stallAt[0] && producerNext < stallAt[0] + stallAt[1];
      if (stalled) {
        pendingBurst.push(chunk);
      } else if (burstEvery) {
        burstDue.push(chunk);
      } else {
        for (const held of pendingBurst) sink.port.onmessage({ data: held });
        pendingBurst = [];
        sink.port.onmessage({ data: chunk });
      }
      producerNext += 0.02 / producerSpeed;
    }
    if (burstEvery && time >= burstNext) {
      for (const held of pendingBurst) burstDue.push(held);
      pendingBurst = [];
      for (const held of burstDue) sink.port.onmessage({ data: held });
      burstDue = [];
      burstNext += burstEvery;
    }

    if (Math.round(time * 10) % 100 === 0) levels.push(sink.bufferedSeconds());
  }

  const tail = levels.slice(-10);
  const finalLevel = tail.reduce((a, b) => a + b, 0) / tail.length;
  const maxLevel = Math.max(...levels);
  const hz = zeroCrossings / (outputFrames / contextRate);
  console.log(
    `${name.padEnd(32)} final=${(finalLevel * 1000).toFixed(0).padStart(3)}ms ` +
      `max=${(maxLevel * 1000).toFixed(0).padStart(3)}ms pitch=${hz.toFixed(1)}Hz ` +
      `maxJump=${maxJump.toFixed(3)} underruns=${underruns} (late=${lateUnderruns})`,
  );

  const ok =
    finalLevel < expect.finalMax &&
    maxLevel < expect.levelMax &&
    hz > 425 &&
    hz < 455 &&
    maxJump < 0.1 &&
    lateUnderruns <= expect.lateUnderrunsMax;
  if (!ok) console.log(`  ^^ FAILED expectations ${JSON.stringify(expect)}`);
  return ok;
}

const clean = { finalMax: 0.08, levelMax: 0.105, lateUnderrunsMax: 0 };
const results = [];
results.push(
  simulate({ name: "matched clocks 48k/48k", contextRate: 48000, chunkRate: 48000, expect: clean }),
);
results.push(
  simulate({
    name: "producer +0.5% fast",
    contextRate: 48000,
    chunkRate: 48000,
    producerSpeed: 1.005,
    expect: clean,
  }),
);
results.push(
  simulate({
    name: "producer -0.5% slow",
    contextRate: 48000,
    chunkRate: 48000,
    producerSpeed: 0.995,
    expect: clean,
  }),
);
results.push(
  simulate({
    name: "context 44.1k, capture 48k",
    contextRate: 44100,
    chunkRate: 48000,
    expect: clean,
  }),
);
results.push(
  simulate({
    name: "1s network stall + burst @20s",
    contextRate: 48000,
    chunkRate: 48000,
    stallAt: [20, 1],
    // One underrun at the stall itself is expected and allowed.
    expect: { finalMax: 0.09, levelMax: 0.2, lateUnderrunsMax: 1 },
  }),
);
results.push(
  simulate({
    name: "producer +3% (forces drops)",
    contextRate: 48000,
    chunkRate: 48000,
    producerSpeed: 1.03,
    expect: { finalMax: 0.13, levelMax: 0.2, lateUnderrunsMax: 0 },
  }),
);
// Fullscreen contention signature: audio arrives in ~80ms clumps. The
// fixed-target buffer stuttered indefinitely here; the adaptive target
// must settle within the warmup and then play clean.
results.push(
  simulate({
    name: "bursty delivery (80ms clumps)",
    contextRate: 48000,
    chunkRate: 48000,
    burstEvery: 0.08,
    expect: { finalMax: 0.2, levelMax: 0.25, lateUnderrunsMax: 0 },
  }),
);
results.push(
  simulate({
    name: "very bursty (150ms clumps)",
    contextRate: 48000,
    chunkRate: 48000,
    burstEvery: 0.15,
    expect: { finalMax: 0.19, levelMax: 0.26, lateUnderrunsMax: 2 },
  }),
);

const pass = results.every(Boolean);
console.log(
  pass
    ? "\nPASS: clean delivery stays in budget; bursty delivery adapts instead of stuttering"
    : "\nFAIL",
);
process.exit(pass ? 0 : 1);
