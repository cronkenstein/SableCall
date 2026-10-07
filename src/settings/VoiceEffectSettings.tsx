/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type ChangeEvent,
  type FC,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  InlineField,
  Label,
  RadioControl,
} from "@vector-im/compound-web";
import { logger } from "matrix-js-sdk/lib/logger";

import { useSetting, voiceEffect } from "./settings";
import { supportsRNNoiseProcessor } from "../audio/RNNoiseProcessor";
import { createVoicePreviewNode } from "../audio/MicrophoneProcessor";
import {
  type VoiceEffectPreset,
  voiceEffectPresets,
} from "../audio/voiceEffects";
import { useMediaDevices } from "../MediaDevicesContext";

/**
 * Plays the microphone back through `preset` while `active`: hearing yourself
 * as everyone else will. The preset can change while it plays.
 */
function useVoicePreview(
  active: boolean,
  preset: VoiceEffectPreset,
  getDeviceId: () => string | undefined,
): void {
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const presetRef = useRef(preset);
  presetRef.current = preset;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;

    const deviceId = getDeviceId();
    void (async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        if (cancelled) return;
        context = new AudioContext();
        const node = await createVoicePreviewNode(context, presetRef.current);
        if (cancelled) return;
        context.createMediaStreamSource(stream).connect(node);
        node.connect(context.destination);
        nodeRef.current = node;
      } catch (e) {
        logger.warn("Voice changer preview could not start", e);
      }
    })();

    return (): void => {
      cancelled = true;
      nodeRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
    // The microphone is read when the preview starts, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    nodeRef.current?.port.postMessage({ type: "preset", preset });
  }, [preset]);
}

interface Props {
  /** In a call, the preview is left out: a second capture can cut the call's microphone. */
  inCall: boolean;
}

export const VoiceEffectSettings: FC<Props> = ({ inCall }): ReactNode => {
  const { t } = useTranslation();
  const supported = supportsRNNoiseProcessor();
  const [preset, setPreset] = useSetting(voiceEffect);
  const group = useId();
  const devices = useMediaDevices();
  const [previewing, setPreviewing] = useState(false);

  const canPreview = supported && !inCall && preset !== "off";
  useVoicePreview(
    previewing && canPreview,
    preset,
    () => devices.audioInput.selected$?.value?.id,
  );

  const labels: Record<VoiceEffectPreset, string> = {
    off: t("settings.audio_tab.voice_effect_off", "Off"),
    deep: t("settings.audio_tab.voice_effect_deep", "Deep"),
    high: t("settings.audio_tab.voice_effect_high", "High"),
    robot: t("settings.audio_tab.voice_effect_robot", "Robot"),
    ghost: t("settings.audio_tab.voice_effect_ghost", "Ghost"),
    demon: t("settings.audio_tab.voice_effect_demon", "Demon"),
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setPreset(e.target.value as VoiceEffectPreset);
  };

  return (
    <>
      <h4>{t("settings.audio_tab.voice_effect_header", "Voice changer")}</h4>
      <p>
        {supported
          ? t(
              "settings.audio_tab.voice_effect_description",
              "Changes how you sound to everyone in the call. It applies straight away, in a call too.",
            )
          : t(
              "settings.audio_tab.voice_effect_not_supported",
              "The voice changer is not supported by this browser.",
            )}
      </p>
      {voiceEffectPresets.map((option) => (
        <InlineField
          key={option}
          name={group}
          control={
            <RadioControl
              checked={preset === option}
              value={option}
              onChange={onChange}
              disabled={!supported}
            />
          }
        >
          <Label>{labels[option]}</Label>
        </InlineField>
      ))}
      {supported && !inCall && (
        <>
          <Button
            kind="secondary"
            size="md"
            disabled={!canPreview}
            onClick={(e): void => {
              e.preventDefault();
              setPreviewing((on) => !on);
            }}
          >
            {previewing && canPreview
              ? t("settings.audio_tab.voice_effect_preview_stop", "Stop")
              : t("settings.audio_tab.voice_effect_preview", "Hear yourself")}
          </Button>
          <p>
            {t(
              "settings.audio_tab.voice_effect_preview_hint",
              "Use headphones, or you will hear yourself twice.",
            )}
          </p>
        </>
      )}
    </>
  );
};
