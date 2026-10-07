/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/lib/logger";

import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";
import type { RNNoiseSuppressionPreset } from "./rnnoiseTypes";
import type { VoiceEffectPreset } from "./voiceEffects";
import {
  createUnsupportedSampleRateError,
  registerRNNoiseWorklet,
  RNNOISE_REQUIRED_SAMPLE_RATE,
  RNNOISE_WORKLET_NAME,
  warnUnsupportedSampleRate,
} from "./RNNoiseProcessor";
import voiceEffectWorkletModuleUrl from "./VoiceEffectWorkletModule.ts?worker&url";

export const MICROPHONE_PROCESSOR_NAME = "sable-microphone";
const VOICE_EFFECT_WORKLET_NAME = "sable-voice-effect";

const voiceWorkletRegistrations = new WeakMap<AudioContext, Promise<void>>();

async function registerVoiceEffectWorklet(
  audioContext: AudioContext,
): Promise<void> {
  const existing = voiceWorkletRegistrations.get(audioContext);
  if (existing) return existing;
  const pending = audioContext.audioWorklet.addModule(
    voiceEffectWorkletModuleUrl,
  );
  voiceWorkletRegistrations.set(audioContext, pending);
  pending.catch(() => {
    voiceWorkletRegistrations.delete(audioContext);
  });
  return pending;
}

export type MicrophoneProcessorConfig = {
  /** RNNoise's preset, or null to leave noise suppression to the browser. */
  denoise: RNNoiseSuppressionPreset | null;
  voice: VoiceEffectPreset;
};

/** Whether `config` needs the processor at all. */
export function microphoneProcessorWanted(
  config: MicrophoneProcessorConfig,
): boolean {
  return config.denoise !== null || config.voice !== "off";
}

/**
 * Everything done to the microphone before it is sent, as one processor:
 * LiveKit runs a single processor per track, and noise suppression and the
 * voice changer both want it.
 *
 *   track → [RNNoise] → [voice changer] → sent
 *
 * Either stage can be switched on, off or to another preset during a call
 * (`configure`); the graph is rewired in place, so the track is never
 * restarted for it.
 */
export class MicrophoneProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  public name = MICROPHONE_PROCESSOR_NAME;
  public processedTrack?: MediaStreamTrack;

  private config: MicrophoneProcessorConfig;
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private denoiseNode?: AudioWorkletNode;
  private voiceNode?: AudioWorkletNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private destroyed = false;

  public constructor(config: MicrophoneProcessorConfig) {
    this.config = config;
  }

  public getConfig(): MicrophoneProcessorConfig {
    return this.config;
  }

  public async init(opts: AudioProcessorOptions): Promise<void> {
    if (this.destinationNode !== undefined) {
      await this.destroy();
    }
    this.destroyed = false;
    const { audioContext, track } = opts;
    this.audioContext = audioContext;
    this.sourceNode = audioContext.createMediaStreamSource(
      new MediaStream([track]),
    );
    this.destinationNode = audioContext.createMediaStreamDestination();
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
    await this.applyConfig();
  }

  /** Switches stages and presets in a running call. */
  public async configure(config: MicrophoneProcessorConfig): Promise<void> {
    this.config = config;
    await this.applyConfig();
  }

  public async restart(opts: AudioProcessorOptions): Promise<void> {
    const audioContext = opts.audioContext ?? this.audioContext;
    if (!audioContext) {
      throw new Error(
        "Microphone processor restart requires an AudioContext when none was initialised.",
      );
    }
    await this.destroy();
    await this.init({ ...opts, audioContext });
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.denoiseNode?.port.postMessage({ type: "destroy" });
    this.sourceNode?.disconnect();
    this.denoiseNode?.disconnect();
    this.voiceNode?.disconnect();
    this.destinationNode?.disconnect();
    try {
      this.processedTrack?.stop();
    } catch (e) {
      logger.warn("Failed to stop the processed microphone track", e);
    }

    this.sourceNode = undefined;
    this.denoiseNode = undefined;
    this.voiceNode = undefined;
    this.destinationNode = undefined;
    this.processedTrack = undefined;
    await Promise.resolve();
  }

  private async applyConfig(): Promise<void> {
    const audioContext = this.audioContext;
    if (!audioContext || this.destroyed) return;
    const { denoise, voice } = this.config;

    if (denoise) {
      if (audioContext.sampleRate !== RNNOISE_REQUIRED_SAMPLE_RATE) {
        warnUnsupportedSampleRate(audioContext.sampleRate);
        throw createUnsupportedSampleRateError(audioContext.sampleRate);
      }
      await registerRNNoiseWorklet(audioContext);
      if (this.destroyed) return;
      this.denoiseNode ??= new AudioWorkletNode(
        audioContext,
        RNNOISE_WORKLET_NAME,
        { channelCount: 1, channelCountMode: "explicit" },
      );
      this.denoiseNode.port.postMessage({ type: "preset", preset: denoise });
    } else if (this.denoiseNode) {
      this.denoiseNode.port.postMessage({ type: "destroy" });
      this.denoiseNode.disconnect();
      this.denoiseNode = undefined;
    }

    if (voice !== "off") {
      await registerVoiceEffectWorklet(audioContext);
      if (this.destroyed) return;
      if (this.voiceNode) {
        this.voiceNode.port.postMessage({ type: "preset", preset: voice });
      } else {
        this.voiceNode = new AudioWorkletNode(
          audioContext,
          VOICE_EFFECT_WORKLET_NAME,
          {
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: { preset: voice },
          },
        );
      }
    } else if (this.voiceNode) {
      this.voiceNode.disconnect();
      this.voiceNode = undefined;
    }

    this.wire();
  }

  private wire(): void {
    const source = this.sourceNode;
    const destination = this.destinationNode;
    if (!source || !destination) return;
    source.disconnect();
    this.denoiseNode?.disconnect();
    this.voiceNode?.disconnect();

    let previous: AudioNode = source;
    for (const stage of [this.denoiseNode, this.voiceNode]) {
      if (!stage) continue;
      previous.connect(stage);
      previous = stage;
    }
    previous.connect(destination);
  }
}

/**
 * The voice changer on its own, for hearing yourself in Settings: the
 * microphone through the preset, out to the speakers.
 */
export async function createVoicePreviewNode(
  audioContext: AudioContext,
  preset: VoiceEffectPreset,
): Promise<AudioWorkletNode> {
  await registerVoiceEffectWorklet(audioContext);
  return new AudioWorkletNode(audioContext, VOICE_EFFECT_WORKLET_NAME, {
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { preset },
  });
}
