/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  isVoiceEffectPreset,
  VoiceEffectDsp,
  type VoiceEffectPreset,
} from "./voiceEffects";

declare abstract class AudioWorkletProcessor {
  protected constructor(options?: AudioWorkletNodeOptions);
  public readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;

const VOICE_EFFECT_WORKLET_NAME = "sable-voice-effect";

type WorkletMessage = { type: "preset"; preset: VoiceEffectPreset };

/** Mono in, mono out: the microphone's voice through the chosen preset. */
class VoiceEffectWorkletProcessor extends AudioWorkletProcessor {
  private readonly dsp = new VoiceEffectDsp(sampleRate);

  public constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const initial: unknown = options?.processorOptions?.preset;
    this.dsp.setPreset(isVoiceEffectPreset(initial) ? initial : "off");
    this.port.onmessage = (event: MessageEvent<WorkletMessage>): void => {
      if (
        event.data.type === "preset" &&
        isVoiceEffectPreset(event.data.preset)
      ) {
        this.dsp.setPreset(event.data.preset);
      }
    };
  }

  public process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    this.dsp.process(input, output);
    return true;
  }
}

registerProcessor(VOICE_EFFECT_WORKLET_NAME, VoiceEffectWorkletProcessor);
