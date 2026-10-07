/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Voice changer presets and the signal processing behind them.
 *
 * Everything here is plain arithmetic on Float32Arrays so it runs unchanged in
 * the AudioWorklet (VoiceEffectWorkletModule.ts) and in unit tests. The chain,
 * per sample: pitch shift → ring modulation → drive → high-pass → echo → blend
 * with the untouched voice.
 */

export const voiceEffectPresets = [
  "off",
  "deep",
  "high",
  "robot",
  "ghost",
  "demon",
] as const;

export type VoiceEffectPreset = (typeof voiceEffectPresets)[number];

export function isVoiceEffectPreset(
  value: unknown,
): value is VoiceEffectPreset {
  return (
    typeof value === "string" &&
    (voiceEffectPresets as readonly string[]).includes(value)
  );
}

export type VoiceEffectParams = {
  /** Playback-rate ratio of the voice: 0.5 is an octave down, 2 an octave up. */
  pitch: number;
  /** Ring modulator frequency in Hz; 0 for none. */
  ringHz: number;
  /** How much of the signal goes through the ring modulator, 0–1. */
  ringMix: number;
  /** Soft-clipping drive; 1 for none. */
  drive: number;
  /** High-pass cut-off in Hz; 0 for none. */
  highPassHz: number;
  /** Echo delay in milliseconds; 0 for none. */
  echoMs: number;
  /** Echo feedback, 0–0.9. */
  echoFeedback: number;
  /** Echo level against the voice, 0–1. */
  echoMix: number;
  /** The untouched voice blended under the effect, 0–1. */
  dryMix: number;
  /** Overall level after the effect. */
  gain: number;
};

const NEUTRAL: VoiceEffectParams = {
  pitch: 1,
  ringHz: 0,
  ringMix: 0,
  drive: 1,
  highPassHz: 0,
  echoMs: 0,
  echoFeedback: 0,
  echoMix: 0,
  dryMix: 0,
  gain: 1,
};

/**
 * The presets. Tuned by ear; every number here is meant to be changed. Each
 * `gain` brings its preset to about the loudness of the voice left alone.
 */
export const VOICE_EFFECT_PARAMS: Record<VoiceEffectPreset, VoiceEffectParams> =
  {
    off: NEUTRAL,
    // About four semitones down.
    deep: { ...NEUTRAL, pitch: 0.78 },
    // About five semitones up.
    high: { ...NEUTRAL, pitch: 1.35 },
    // A ring modulator at a low drone, the classic robot.
    robot: { ...NEUTRAL, ringHz: 55, ringMix: 0.9, drive: 1.6, gain: 0.95 },
    // Thin, slightly lower, and haunting the room it is in.
    ghost: {
      ...NEUTRAL,
      pitch: 0.92,
      highPassHz: 420,
      echoMs: 190,
      echoFeedback: 0.45,
      echoMix: 0.55,
      gain: 1.55,
    },
    // An octave and a bit down, gritty, with the real voice underneath.
    demon: { ...NEUTRAL, pitch: 0.6, drive: 2.6, dryMix: 0.3, gain: 0.47 },
  };

/** Length of the pitch shifter's grain window. Longer is smoother but lags more. */
const PITCH_WINDOW_MS = 46;
/** The echo line's longest delay. */
const MAX_ECHO_MS = 500;

/**
 * The voice changer for one mono stream at one sample rate.
 *
 * Pitch shifting is the two-grain delay-line method: two read heads sweep
 * through a short delay line at the speed the pitch change asks for, half a
 * window apart, each faded in and out with a Hann window so that one is always
 * at full level while the other jumps back. Cheap, no lookahead, and a latency
 * of about half a window.
 */
export class VoiceEffectDsp {
  private readonly sampleRate: number;
  private params: VoiceEffectParams = NEUTRAL;

  // Pitch shifter.
  private readonly pitchBuf: Float32Array;
  private pitchW = 0;
  private readonly windowLen: number;
  private phase = 0;

  // Ring modulator.
  private ringPhase = 0;

  // One-pole high-pass.
  private hpPrevIn = 0;
  private hpPrevOut = 0;
  private hpCoef = 0;

  // Echo.
  private readonly echoBuf: Float32Array;
  private echoW = 0;
  private echoDelay = 0;

  public constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.windowLen = Math.max(
      64,
      Math.round((PITCH_WINDOW_MS / 1000) * sampleRate),
    );
    // Room for a full window behind the write head, plus interpolation slack.
    this.pitchBuf = new Float32Array(this.windowLen * 2 + 8);
    this.echoBuf = new Float32Array(
      Math.ceil((MAX_ECHO_MS / 1000) * sampleRate) + 2,
    );
  }

  public setPreset(preset: VoiceEffectPreset): void {
    this.setParams(VOICE_EFFECT_PARAMS[preset]);
  }

  public setParams(params: VoiceEffectParams): void {
    this.params = params;
    this.hpCoef =
      params.highPassHz > 0
        ? Math.exp((-2 * Math.PI * params.highPassHz) / this.sampleRate)
        : 0;
    this.echoDelay = Math.min(
      this.echoBuf.length - 1,
      Math.round(
        (Math.min(params.echoMs, MAX_ECHO_MS) / 1000) * this.sampleRate,
      ),
    );
    if (this.echoDelay === 0) this.echoBuf.fill(0);
  }

  /** Processes one block; `output` may be the same array as `input`. */
  public process(input: Float32Array, output: Float32Array): void {
    const p = this.params;
    const length = Math.min(input.length, output.length);
    const pitched = p.pitch !== 1;
    const ringStep = (2 * Math.PI * p.ringHz) / this.sampleRate;
    const driveNorm = p.drive > 1 ? Math.tanh(p.drive) : 1;

    for (let i = 0; i < length; i++) {
      const dry = input[i];
      let y = pitched ? this.pitchSample(dry) : dry;

      if (p.ringMix > 0 && p.ringHz > 0) {
        y *= 1 - p.ringMix + p.ringMix * Math.sin(this.ringPhase);
        this.ringPhase += ringStep;
        if (this.ringPhase > 2 * Math.PI) this.ringPhase -= 2 * Math.PI;
      }

      if (p.drive > 1) y = Math.tanh(p.drive * y) / driveNorm;

      if (this.hpCoef > 0) {
        const out = this.hpCoef * (this.hpPrevOut + y - this.hpPrevIn);
        this.hpPrevIn = y;
        this.hpPrevOut = out;
        y = out;
      }

      if (this.echoDelay > 0) {
        const len = this.echoBuf.length;
        const read = this.echoBuf[(this.echoW - this.echoDelay + len) % len];
        this.echoBuf[this.echoW] = y + p.echoFeedback * read;
        this.echoW = (this.echoW + 1) % len;
        y += p.echoMix * read;
      }

      const out = (y + p.dryMix * dry) * p.gain;
      // Never hand the encoder anything it cannot take.
      output[i] = Number.isFinite(out) ? Math.max(-1, Math.min(1, out)) : 0;
    }
  }

  private pitchSample(sample: number): number {
    const len = this.pitchBuf.length;
    this.pitchBuf[this.pitchW] = sample;

    let out = 0;
    for (let head = 0; head < 2; head++) {
      let headPhase = this.phase + head * 0.5;
      if (headPhase >= 1) headPhase -= 1;
      // At least two samples behind the write head, so interpolation reads the past.
      const delay = 2 + headPhase * this.windowLen;
      let readPos = this.pitchW - delay;
      if (readPos < 0) readPos += len;
      const i0 = Math.floor(readPos);
      const frac = readPos - i0;
      const a = this.pitchBuf[i0];
      const b = this.pitchBuf[(i0 + 1) % len];
      const s = Math.sin(Math.PI * headPhase);
      out += (a + (b - a) * frac) * s * s;
    }

    this.pitchW = (this.pitchW + 1) % len;
    // The delay grows when the pitch drops and shrinks when it rises.
    this.phase += (1 - this.params.pitch) / this.windowLen;
    this.phase -= Math.floor(this.phase);
    return out;
  }
}
