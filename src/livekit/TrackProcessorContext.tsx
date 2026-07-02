/*
Copyright 2024-2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  ProcessorWrapper,
  supportsBackgroundProcessors,
  type BackgroundOptions,
} from "@livekit/track-processors";
import {
  createContext,
  type FC,
  type JSX,
  use,
  useEffect,
  useMemo,
} from "react";
import { type LocalVideoTrack } from "livekit-client";
import { combineLatest, map, type Observable } from "rxjs";
import { useObservable } from "observable-hooks";

import {
  backgroundBlur as backgroundBlurSettings,
  useSetting,
} from "../settings/settings";
import { BlurBackgroundTransformer } from "./BlurBackgroundTransformer";
import { type Behavior } from "../state/Behavior";
import { type ObservableScope } from "../state/ObservableScope";

//TODO-MULTI-SFU: This is not yet fully there.
// it is a combination of exposing observable and react hooks.
// preferably we should not make this a context anymore and instead just a vm?

const BLUR_RADIUS = 15;

export type ProcessorState = {
  supported: boolean | undefined;
  processor: undefined | ProcessorWrapper<BackgroundOptions>;
  blurEnabled: boolean;
};

const ProcessorContext = createContext<ProcessorState | undefined>(undefined);

export function useTrackProcessor(): ProcessorState {
  const state = use(ProcessorContext);
  if (state === undefined)
    throw new Error(
      "useTrackProcessor must be used within a ProcessorProvider",
    );
  return state;
}

export function useTrackProcessorObservable$(): Observable<ProcessorState> {
  const state = use(ProcessorContext);
  if (state === undefined)
    throw new Error(
      "useTrackProcessor must be used within a ProcessorProvider",
    );
  const state$ = useObservable(
    (init$) => init$.pipe(map(([init]) => init)),
    [state],
  );

  return state$;
}

/**
 * Keeps background blur in sync without tearing down the LiveKit processor pipeline.
 * Disabling blur switches to passthrough mode instead of stopProcessor(), which avoids
 * a black camera feed after toggling blur off.
 */
export async function syncVideoTrackProcessor(
  videoTrack: LocalVideoTrack,
  processorState: ProcessorState,
): Promise<void> {
  const { processor, blurEnabled } = processorState;
  if (!processor) return;

  if (blurEnabled) {
    if (!videoTrack.getProcessor()) {
      await videoTrack.setProcessor(processor);
    }
    await processor.updateTransformerOptions({
      backgroundDisabled: false,
      blurRadius: BLUR_RADIUS,
    });
    return;
  }

  if (videoTrack.getProcessor() === processor) {
    await processor.updateTransformerOptions({
      backgroundDisabled: true,
      blurRadius: BLUR_RADIUS,
    });
  }
}

/**
 * Updates your video tracks to always use the given processor.
 */
export const trackProcessorSync = (
  scope: ObservableScope,
  videoTrack$: Behavior<LocalVideoTrack | null>,
  processor$: Behavior<ProcessorState>,
): void => {
  combineLatest([videoTrack$, processor$])
    .pipe(scope.bind())
    .subscribe(([videoTrack, processorState]) => {
      if (!processorState || !videoTrack) return;

      void syncVideoTrackProcessor(videoTrack, processorState).catch((error) => {
        console.error("Failed to sync video track processor", error);
      });
    });
};

export const useTrackProcessorSync = (
  videoTrack: LocalVideoTrack | null,
): void => {
  const processorState = useTrackProcessor();

  useEffect(() => {
    if (!videoTrack) return;

    void syncVideoTrackProcessor(videoTrack, processorState).catch((error) => {
      console.error("Failed to sync video track processor", error);
    });
  }, [processorState, videoTrack]);
};

interface Props {
  children: JSX.Element;
}

export const ProcessorProvider: FC<Props> = ({ children }) => {
  const [blurActivated] = useSetting(backgroundBlurSettings);
  const supported = useMemo(() => supportsBackgroundProcessors(), []);
  const blur = useMemo(
    () =>
      new ProcessorWrapper(
        new BlurBackgroundTransformer({
          blurRadius: BLUR_RADIUS,
          backgroundDisabled: true,
        }),
        "background-blur",
      ),
    [],
  );

  const processorState = useMemo(
    () => ({
      supported,
      processor: supported ? blur : undefined,
      blurEnabled: supported && blurActivated,
    }),
    [supported, blurActivated, blur],
  );

  return <ProcessorContext value={processorState}>{children}</ProcessorContext>;
};
