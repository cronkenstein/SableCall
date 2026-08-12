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
  new URL(
    "../../src/state/CallViewModel/localMember/NativeScreenShare.ts",
    import.meta.url,
  ),
  "utf8",
);
const match = ts.match(/const AUDIO_SINK_WORKLET = `\n([\s\S]*?)`;/);
if (!match) throw new Error("worklet source not found");

const constants = {};
for (const m of ts.matchAll(
  /^const ([A-Z_0-9]+) = ([0-9.]+|0x[0-9a-f]+);$/gm,
)) {
  constants[m[1]] = m[2];
}

// The interpolator is injected as source rather than as a number, because the
// worklet cannot import it. Pull it from the same module the unit tests use so
// this harness exercises the kernel that actually ships.
const interpolationTs = readFileSync(
  new URL(
    "../../src/state/CallViewModel/localMember/audioInterpolation.ts",
    import.meta.url,
  ),
  "utf8",
);
const fnMatch = interpolationTs.match(
  /export function (cubicInterpolate)\(([\s\S]*?)\n\}/,
);
if (!fnMatch) throw new Error("cubicInterpolate source not found");
constants.CUBIC_INTERPOLATE_SOURCE = `function ${fnMatch[1]}(${fnMatch[2]}\n}`
  // Strip TypeScript annotations; the worklet runs plain JS.
  .replace(/:\s*number/g, "");

// SIM_INTERPOLATOR=linear reinstates the old two-point kernel, so the cost of
// changing it can be measured rather than argued about. Compare the ripple
// figures on the high-frequency scenarios between the two.
// Override any extracted constant to explore a change before committing to it:
//   SIM_CONST_MAX_RATE_NUDGE=0.005 node scripts/native-screenshare/worklet-sim.mjs
// The header rule is to run this before tuning anything here; this makes the
// sweep itself cheap.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("SIM_CONST_")) continue;
  const name = key.slice("SIM_CONST_".length);
  if (!(name in constants)) throw new Error(`unknown constant ${name}`);
  constants[name] = value;
  console.log(`[sim] ${name} = ${value} (override)`);
}

if (process.env.SIM_INTERPOLATOR === "linear") {
  constants.CUBIC_INTERPOLATE_SOURCE =
    "function linearInterpolate(ym1, y0, y1, y2, t) { return y0 + (y1 - y0) * t; }";
  console.log("[sim] using LINEAR interpolation (SIM_INTERPOLATOR=linear)\n");
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
  toneHz = 440,
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
  // Peak output level per window. The resampling artifact is amplitude
  // modulation, so a steady input tone whose envelope wobbles is the signal
  // we are hunting — invisible to the pitch and latency checks.
  const envelope = [];
  // RMS, not peak: at 12 kHz there are only four samples per cycle, so a peak
  // measure mostly reports where the sampling grid lands relative to the crest
  // — sampling phase, not interpolator gain. RMS over many cycles is blind to
  // that and sees only the modulation we care about.
  let windowSumSq = 0;
  let windowFrames = 0;
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
      windowSumSq += v * v;
      windowFrames++;
      if (windowFrames >= 2048) {
        // Warmup excluded: the fade-in ramp is a legitimate level change.
        if (time > 5) envelope.push(Math.sqrt(windowSumSq / windowFrames));
        windowSumSq = 0;
        windowFrames = 0;
      }
    }
    outputFrames += quantum;
    time += quantum / contextRate;

    while (producerNext <= time) {
      const chunk = makeChunk(chunkRate, chunkFrames, phaseRef, toneHz);
      const stalled =
        stallAt &&
        producerNext >= stallAt[0] &&
        producerNext < stallAt[0] + stallAt[1];
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
  // Ripple across the steady-state envelope, in dB.
  const envMax = envelope.length ? Math.max(...envelope) : 0;
  const envMin = envelope.length ? Math.min(...envelope) : 0;
  const rippleDb =
    envMin > 0 ? 20 * Math.log10(envMax) - 20 * Math.log10(envMin) : Infinity;
  console.log(
    `${name.padEnd(32)} final=${(finalLevel * 1000).toFixed(0).padStart(3)}ms ` +
      `max=${(maxLevel * 1000).toFixed(0).padStart(3)}ms pitch=${hz.toFixed(1)}Hz ` +
      `maxJump=${maxJump.toFixed(3)} underruns=${underruns} (late=${lateUnderruns})` +
      (expect && expect.maxRippleDb !== undefined
        ? ` ripple=${rippleDb.toFixed(2)}dB`
        : ""),
  );

  const ok =
    finalLevel < expect.finalMax &&
    maxLevel < expect.levelMax &&
    // Pitch tolerance scales with the tone: zero-crossing counting is coarser
    // the closer the tone sits to Nyquist.
    hz > toneHz * 0.965 &&
    hz < toneHz * 1.035 &&
    maxJump < expect.maxJumpMax &&
    lateUnderruns <= expect.lateUnderrunsMax &&
    (expect.maxRippleDb === undefined || rippleDb < expect.maxRippleDb);
  if (!ok) console.log(`  ^^ FAILED expectations ${JSON.stringify(expect)}`);
  return ok;
}

const clean = {
  finalMax: 0.08,
  levelMax: 0.105,
  lateUnderrunsMax: 0,
  maxJumpMax: 0.1,
};
const results = [];
results.push(
  simulate({
    name: "matched clocks 48k/48k",
    contextRate: 48000,
    chunkRate: 48000,
    expect: clean,
  }),
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
    expect: {
      finalMax: 0.09,
      levelMax: 0.2,
      lateUnderrunsMax: 1,
      maxJumpMax: 0.1,
    },
  }),
);
results.push(
  simulate({
    name: "producer +3% (forces drops)",
    contextRate: 48000,
    chunkRate: 48000,
    producerSpeed: 1.03,
    expect: {
      finalMax: 0.13,
      levelMax: 0.2,
      lateUnderrunsMax: 0,
      maxJumpMax: 0.1,
    },
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
    expect: {
      finalMax: 0.2,
      levelMax: 0.25,
      lateUnderrunsMax: 0,
      maxJumpMax: 0.1,
    },
  }),
);
results.push(
  simulate({
    name: "very bursty (150ms clumps)",
    contextRate: 48000,
    chunkRate: 48000,
    burstEvery: 0.15,
    expect: {
      finalMax: 0.19,
      levelMax: 0.26,
      lateUnderrunsMax: 2,
      maxJumpMax: 0.1,
    },
  }),
);

// High-frequency fidelity. The drift nudge sweeps the interpolator's
// fractional phase continuously, so a phase-dependent kernel amplitude-
// modulates the treble — heard as shimmer on cymbals, applause and rain.
// A 440 Hz tone cannot see this at all, which is how linear interpolation
// shipped: every check above passed while 12 kHz was wobbling.
//
// Measured RMS ripple, matched clocks: linear 0.92 dB, cubic 0.35 dB. Verify
// with SIM_INTERPOLATOR=linear before changing the bound — a threshold that
// both kernels pass is worse than no threshold, because it looks like cover.
//
// This is deliberately the coarse check. The precise guard is the frequency
// response in audioInterpolation.test.ts; the value here is proving the
// kernel is really wired into the worklet and has not upset the jitter
// buffer. Ripple understates the true modulation depth, because the buffer
// sits near target so the phase sweeps slowly and RMS averages part of it.
results.push(
  simulate({
    name: "12kHz tone, matched clocks",
    contextRate: 48000,
    chunkRate: 48000,
    toneHz: 12000,
    expect: {
      finalMax: 0.08,
      levelMax: 0.105,
      lateUnderrunsMax: 0,
      // Consecutive samples of a 12 kHz tone legitimately swing far more
      // than a 440 Hz one; this bound is about declicking, not slew.
      maxJumpMax: 2.1,
      // Between the two kernels (linear 0.92, cubic 0.35), so a regression
      // to two-point interpolation fails here.
      maxRippleDb: 0.6,
    },
  }),
);
results.push(
  simulate({
    name: "12kHz tone, 44.1k ctx / 48k cap",
    contextRate: 44100,
    chunkRate: 48000,
    toneHz: 12000,
    expect: {
      finalMax: 0.09,
      levelMax: 0.11,
      lateUnderrunsMax: 0,
      maxJumpMax: 2.1,
      // No ripple bound: at a fixed resampling ratio the phase sweeps fast and
      // uniformly, so RMS averages the modulation away and both kernels read
      // ~0.01 dB. Kept for stability under sample-rate mismatch, not fidelity.
    },
  }),
);

const pass = results.every(Boolean);
console.log(
  pass
    ? "\nPASS: clean delivery stays in budget; bursty delivery adapts instead of stuttering"
    : "\nFAIL",
);
process.exit(pass ? 0 : 1);
