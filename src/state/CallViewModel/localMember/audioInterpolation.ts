/*
Copyright 2026 Sable

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Fractional-sample interpolation for the native screen share jitter buffer.
 *
 * The buffer never reads its input at exactly 1.0 samples per output frame:
 * the drift nudge steers the read rate continuously to hold the fill target,
 * so the fractional phase sweeps constantly even when capture and context
 * sample rates match. Whatever interpolator sits here is therefore in the
 * path for *every* frame of shared audio, not just during resampling.
 *
 * That makes its frequency response audible. Linear interpolation is a
 * fractional-delay filter whose gain depends on the phase:
 *
 *   |H(f)| = |1 - t + t·e^(-j2πf/fs)|
 *
 * At t=0 or t=1 it is unity; at t=0.5 it falls to |cos(πf/fs)| — about
 * -6 dB at 16 kHz. As the phase sweeps, high frequencies are amplitude
 * modulated by that much, which is heard as a shimmer or "swirl" on
 * broadband content: cymbals, applause, rainfall. Steady tones and speech
 * are barely affected, which is why a 440 Hz test signal misses it entirely.
 *
 * Catmull-Rom cubic keeps four points instead of two and holds high
 * frequencies far closer to unity across the whole phase sweep, which
 * collapses the modulation rather than merely attenuating the average.
 *
 * This lives in its own module so it can be tested directly. The worklet
 * cannot import — it is instantiated from a source string — so
 * {@link CUBIC_INTERPOLATE_SOURCE} injects the identical function there.
 * Keep it self-contained: no imports, no closure variables, nothing that
 * would not survive `Function.prototype.toString()`.
 */
export function cubicInterpolate(
  ym1: number,
  y0: number,
  y1: number,
  y2: number,
  t: number,
): number {
  // Catmull-Rom, expanded to avoid recomputing the basis per call.
  const c0 = y0;
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

/**
 * The source of {@link cubicInterpolate}, for injection into the audio
 * worklet. Assign it to a name of your choosing — do not rely on the
 * function's own identifier surviving minification:
 *
 * ```js
 * const interpolate = ${CUBIC_INTERPOLATE_SOURCE};
 * ```
 */
export const CUBIC_INTERPOLATE_SOURCE = cubicInterpolate.toString();
