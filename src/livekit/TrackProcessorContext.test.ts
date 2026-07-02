/*
Copyright 2024-2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { type LocalVideoTrack } from "livekit-client";
import { type BackgroundOptions, type ProcessorWrapper } from "@livekit/track-processors";

import {
  type ProcessorState,
  syncVideoTrackProcessor,
} from "./TrackProcessorContext";

function createProcessorState(
  overrides: Partial<ProcessorState> = {},
): ProcessorState {
  return {
    supported: true,
    processor: undefined,
    blurEnabled: false,
    ...overrides,
  };
}

function createVideoTrack(
  processor: ProcessorWrapper | undefined = undefined,
): LocalVideoTrack {
  return {
    getProcessor: vi.fn(() => processor),
    setProcessor: vi.fn().mockResolvedValue(undefined),
    stopProcessor: vi.fn().mockResolvedValue(undefined),
  } as unknown as LocalVideoTrack;
}

describe("syncVideoTrackProcessor", () => {
  it("attaches the processor when blur is enabled", async () => {
    const processor = {
      updateTransformerOptions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProcessorWrapper<BackgroundOptions>;
    const videoTrack = createVideoTrack();

    await syncVideoTrackProcessor(
      videoTrack,
      createProcessorState({ processor, blurEnabled: true }),
    );

    expect(videoTrack.setProcessor).toHaveBeenCalledWith(processor);
    expect(processor.updateTransformerOptions).toHaveBeenCalledWith({
      backgroundDisabled: false,
      blurRadius: 15,
    });
    expect(videoTrack.stopProcessor).not.toHaveBeenCalled();
  });

  it("switches to passthrough mode instead of stopping the processor when blur is disabled", async () => {
    const processor = {
      updateTransformerOptions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProcessorWrapper<BackgroundOptions>;
    const videoTrack = createVideoTrack(processor);

    await syncVideoTrackProcessor(
      videoTrack,
      createProcessorState({ processor, blurEnabled: false }),
    );

    expect(processor.updateTransformerOptions).toHaveBeenCalledWith({
      backgroundDisabled: true,
      blurRadius: 15,
    });
    expect(videoTrack.stopProcessor).not.toHaveBeenCalled();
    expect(videoTrack.setProcessor).not.toHaveBeenCalled();
  });

  it("does nothing when blur is disabled and the processor was never attached", async () => {
    const processor = {
      updateTransformerOptions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProcessorWrapper<BackgroundOptions>;
    const videoTrack = createVideoTrack();

    await syncVideoTrackProcessor(
      videoTrack,
      createProcessorState({ processor, blurEnabled: false }),
    );

    expect(processor.updateTransformerOptions).not.toHaveBeenCalled();
    expect(videoTrack.setProcessor).not.toHaveBeenCalled();
    expect(videoTrack.stopProcessor).not.toHaveBeenCalled();
  });
});
