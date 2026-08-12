/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  CUBIC_INTERPOLATE_SOURCE,
  cubicInterpolate,
} from "./audioInterpolation";

type Interpolator = (
  ym1: number,
  y0: number,
  y1: number,
  y2: number,
  t: number,
) => number;

/** What the jitter buffer used to do, kept as the comparison baseline. */
const linearInterpolate: Interpolator = (_ym1, y0, y1, _y2, t) =>
  y0 + (y1 - y0) * t;

/**
 * Effective gain at a given frequency and fractional phase.
 *
 * Projects the interpolated signal onto the ideal one sampled at the same
 * fractional offset, which yields the interpolator's gain at that frequency
 * — the quantity that has to stay flat as the phase sweeps.
 */
function gainAt(
  interpolate: Interpolator,
  freqHz: number,
  phase: number,
  sampleRate = 48_000,
): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  let numerator = 0;
  let denominator = 0;
  for (let n = 2; n < 4096; n++) {
    const got = interpolate(
      Math.sin(w * (n - 1)),
      Math.sin(w * n),
      Math.sin(w * (n + 1)),
      Math.sin(w * (n + 2)),
      phase,
    );
    const want = Math.sin(w * (n + phase));
    numerator += got * want;
    denominator += want * want;
  }
  return numerator / denominator;
}

/**
 * Peak-to-peak gain variation across a full phase sweep, in dB.
 *
 * This is the artifact itself. The drift nudge sweeps the phase continuously,
 * so any phase-dependent gain becomes amplitude modulation of that frequency
 * — heard as shimmer on cymbals, applause and rain.
 */
function modulationDepthDb(
  interpolate: Interpolator,
  freqHz: number,
  sampleRate = 48_000,
): number {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const gain = gainAt(interpolate, freqHz, i / 40, sampleRate);
    min = Math.min(min, gain);
    max = Math.max(max, gain);
  }
  return 20 * Math.log10(max) - 20 * Math.log10(min);
}

describe("cubicInterpolate", () => {
  describe("exactness at and between samples", () => {
    it("reproduces the sample either side exactly", () => {
      // Non-negotiable: when capture and context rates match and the nudge is
      // at rest, the phase sits on a node and playback must be bit-faithful
      // rather than filtered.
      expect(cubicInterpolate(0.3, -0.7, 0.9, 0.1, 0)).toBeCloseTo(-0.7, 12);
      expect(cubicInterpolate(0.3, -0.7, 0.9, 0.1, 1)).toBeCloseTo(0.9, 12);
    });

    it("preserves DC at every phase", () => {
      for (let i = 0; i <= 20; i++) {
        expect(cubicInterpolate(0.42, 0.42, 0.42, 0.42, i / 20)).toBeCloseTo(
          0.42,
          12,
        );
      }
    });

    it("reproduces a linear ramp exactly", () => {
      // A cubic through four collinear points is that line.
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(cubicInterpolate(-1, 0, 1, 2, t)).toBeCloseTo(t, 12);
      }
    });

    it("reproduces a quadratic exactly", () => {
      const f = (x: number): number => 2 * x * x - 3 * x + 1;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(cubicInterpolate(f(-1), f(0), f(1), f(2), t)).toBeCloseTo(
          f(t),
          10,
        );
      }
    });

    it("is symmetric under reversal", () => {
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(cubicInterpolate(0.2, -0.5, 0.8, 0.1, t)).toBeCloseTo(
          cubicInterpolate(0.1, 0.8, -0.5, 0.2, 1 - t),
          12,
        );
      }
    });
  });

  describe("frequency response", () => {
    it("is transparent well below Nyquist", () => {
      for (let i = 0; i <= 10; i++) {
        expect(gainAt(cubicInterpolate, 1000, i / 10)).toBeGreaterThan(0.999);
      }
    });

    it.each([
      { freqHz: 8_000, maxDb: 0.5 },
      { freqHz: 12_000, maxDb: 1.5 },
      { freqHz: 16_000, maxDb: 4.0 },
    ])(
      "keeps phase-dependent modulation under $maxDb dB at $freqHz Hz",
      ({ freqHz, maxDb }) => {
        expect(modulationDepthDb(cubicInterpolate, freqHz)).toBeLessThan(maxDb);
      },
    );

    // Improvement over linear narrows as frequency rises: four points only
    // buy so much near Nyquist. Measured factors are 5.4x / 2.8x / 1.9x;
    // these floors leave headroom without pretending 16 kHz is solved.
    it.each([
      { freqHz: 8_000, atLeastTimesBetter: 4 },
      { freqHz: 12_000, atLeastTimesBetter: 2.2 },
      { freqHz: 16_000, atLeastTimesBetter: 1.6 },
    ])(
      "modulates at least $atLeastTimesBetter x less than linear at $freqHz Hz",
      ({ freqHz, atLeastTimesBetter }) => {
        const cubic = modulationDepthDb(cubicInterpolate, freqHz);
        const linear = modulationDepthDb(linearInterpolate, freqHz);
        expect(cubic).toBeLessThan(linear / atLeastTimesBetter);
      },
    );

    it("does not buy flatness by attenuating the treble", () => {
      // The trap this guards: an approximating kernel (e.g. Niemitalo's
      // optimal 4-point, which assumes oversampled input) measures beautifully
      // flat because it low-passes everything — 0.79 gain at 8 kHz, 0.37 at
      // 16 kHz. Flat modulation is only worth having if the signal survives.
      for (let i = 0; i <= 20; i++) {
        expect(gainAt(cubicInterpolate, 8_000, i / 20)).toBeGreaterThan(0.95);
      }
    });
  });

  describe("robustness", () => {
    it("stays bounded on a step", () => {
      // Catmull-Rom overshoots a discontinuity; it must stay within sane
      // bounds so a transient cannot clip the output.
      for (let i = 0; i <= 20; i++) {
        const value = cubicInterpolate(-1, -1, 1, 1, i / 20);
        expect(value).toBeGreaterThan(-1.3);
        expect(value).toBeLessThan(1.3);
      }
    });

    it("stays finite at full scale", () => {
      for (let i = 0; i <= 20; i++) {
        const value = cubicInterpolate(-1, 1, -1, 1, i / 20);
        expect(Number.isFinite(value)).toBe(true);
      }
    });

    it("handles silence", () => {
      expect(cubicInterpolate(0, 0, 0, 0, 0.5)).toBe(0);
    });
  });

  describe("worklet injection", () => {
    it("round-trips through the source string", () => {
      // The worklet cannot import, so it is handed this source text. If
      // bundling ever mangles it into something that stops matching the
      // module, shared audio silently diverges from what is tested here.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const injected = new Function(
        `return (${CUBIC_INTERPOLATE_SOURCE});`,
      )() as Interpolator;

      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        expect(injected(0.3, -0.7, 0.9, 0.1, t)).toBe(
          cubicInterpolate(0.3, -0.7, 0.9, 0.1, t),
        );
      }
    });

    it("depends on nothing outside its arguments", () => {
      // A closure reference would survive here but break inside the worklet,
      // where the surrounding module does not exist.
      expect(CUBIC_INTERPOLATE_SOURCE).not.toMatch(/\bimport\b|\brequire\b/);
    });
  });
});
