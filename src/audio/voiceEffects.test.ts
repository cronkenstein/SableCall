/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  VOICE_EFFECT_PARAMS,
  VoiceEffectDsp,
  isVoiceEffectPreset,
  voiceEffectPresets,
} from "./voiceEffects";

const SAMPLE_RATE = 48000;
const BLOCK = 128;

function sine(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return samples;
}

/** Runs a whole signal through in worklet-sized blocks. */
function run(dsp: VoiceEffectDsp, input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let start = 0; start < input.length; start += BLOCK) {
    const end = Math.min(start + BLOCK, input.length);
    dsp.process(input.subarray(start, end), output.subarray(start, end));
  }
  return output;
}

/**
 * The dominant frequency, from the autocorrelation peak: zero crossings are
 * thrown off by the grain cross-fades, a repeating period is not.
 */
function dominantHz(signal: Float32Array, minHz = 60, maxHz = 800): number {
  const minLag = Math.floor(SAMPLE_RATE / maxHz);
  const maxLag = Math.ceil(SAMPLE_RATE / minHz);
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < signal.length; i++)
      sum += signal[i] * signal[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return SAMPLE_RATE / bestLag;
}

describe("VoiceEffectDsp", () => {
  it("passes the voice through untouched when off", () => {
    const dsp = new VoiceEffectDsp(SAMPLE_RATE);
    dsp.setPreset("off");
    const input = sine(220, 0.2);
    const output = run(dsp, input);
    for (let i = 0; i < input.length; i++) {
      expect(output[i]).toBeCloseTo(input[i], 6);
    }
  });

  it.each([
    ["deep", VOICE_EFFECT_PARAMS.deep.pitch],
    ["high", VOICE_EFFECT_PARAMS.high.pitch],
  ] as const)("moves the pitch for %s", (preset, ratio) => {
    const dsp = new VoiceEffectDsp(SAMPLE_RATE);
    dsp.setPreset(preset);
    const output = run(dsp, sine(220, 1));
    // Past the first window, where the delay line is still filling.
    const steady = output.subarray(SAMPLE_RATE / 2);
    expect(dominantHz(steady)).toBeGreaterThan(220 * ratio * 0.95);
    expect(dominantHz(steady)).toBeLessThan(220 * ratio * 1.05);
  });

  it.each(voiceEffectPresets)(
    "keeps %s finite and within full scale, even driven hard",
    (preset) => {
      const dsp = new VoiceEffectDsp(SAMPLE_RATE);
      dsp.setPreset(preset);
      const output = run(dsp, sine(180, 0.5, 1));
      for (const sample of output) {
        expect(Number.isFinite(sample)).toBe(true);
        expect(Math.abs(sample)).toBeLessThanOrEqual(1);
      }
    },
  );

  it.each(voiceEffectPresets.filter((preset) => preset !== "off"))(
    "changes the voice for %s",
    (preset) => {
      const dsp = new VoiceEffectDsp(SAMPLE_RATE);
      dsp.setPreset(preset);
      const input = sine(220, 0.5);
      const output = run(dsp, input);
      let difference = 0;
      for (let i = 0; i < input.length; i++) {
        difference += Math.abs(output[i] - input[i]);
      }
      expect(difference / input.length).toBeGreaterThan(0.01);
    },
  );

  it("lets the ghost's echo die away in silence", () => {
    const dsp = new VoiceEffectDsp(SAMPLE_RATE);
    dsp.setPreset("ghost");
    run(dsp, sine(220, 0.3));
    const tail = run(dsp, new Float32Array(SAMPLE_RATE * 3));
    const last = tail.subarray(tail.length - SAMPLE_RATE / 10);
    expect(Math.max(...last.map(Math.abs))).toBeLessThan(0.01);
  });

  it("drops the ghost's echo at once when switched off", () => {
    const dsp = new VoiceEffectDsp(SAMPLE_RATE);
    dsp.setPreset("ghost");
    run(dsp, sine(220, 0.3));
    dsp.setPreset("off");
    const output = run(dsp, new Float32Array(BLOCK * 4));
    expect(Math.max(...output.map(Math.abs))).toBe(0);
  });
});

describe("isVoiceEffectPreset", () => {
  it("accepts the presets and nothing else", () => {
    for (const preset of voiceEffectPresets) {
      expect(isVoiceEffectPreset(preset)).toBe(true);
    }
    expect(isVoiceEffectPreset("chipmunk")).toBe(false);
    expect(isVoiceEffectPreset(undefined)).toBe(false);
  });
});
