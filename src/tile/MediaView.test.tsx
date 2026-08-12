/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { TooltipProvider } from "@vector-im/compound-web";
import {
  type TrackReference,
  type TrackReferencePlaceholder,
} from "@livekit/components-core";
import { LocalTrackPublication, Track } from "livekit-client";
import { TrackInfo } from "@livekit/protocol";
import { type ComponentProps } from "react";

import { MediaView } from "./MediaView";
import { mockLocalParticipant } from "../utils/test";

describe("MediaView", () => {
  const participant = mockLocalParticipant({});
  const trackReferencePlaceholder: TrackReferencePlaceholder = {
    participant,
    source: Track.Source.Camera,
  };
  const trackReference: TrackReference = {
    ...trackReferencePlaceholder,
    publication: new LocalTrackPublication(
      Track.Kind.Video,
      new TrackInfo({ sid: "id", name: "name" }),
    ),
  };

  const baseProps: ComponentProps<typeof MediaView> = {
    displayName: "some name",
    videoEnabled: true,
    videoFit: "contain",
    targetWidth: 300,
    targetHeight: 200,
    mirror: false,
    unencryptedWarning: false,
    showNameTags: true,
    video: trackReference,
    userId: "@alice:example.com",
    mxcAvatarUrl: undefined,
    focusable: true,
  };

  test("is accessible", async () => {
    const { container } = render(<MediaView {...baseProps} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  describe("placeholder track", () => {
    test("neither video nor avatar are shown", () => {
      render(<MediaView {...baseProps} video={trackReferencePlaceholder} />);
      expect(screen.queryByTestId("video")).toBeNull();
      expect(
        screen.queryAllByRole("img", { name: "@alice:example.com" }).length,
      ).toBe(0);
    });
  });

  describe("with no video", () => {
    it("shows avatar", () => {
      render(<MediaView {...baseProps} video={undefined} />);
      expect(
        screen.getByRole("img", { name: "@alice:example.com" }),
      ).toBeVisible();
      expect(screen.queryByTestId("video")).toBe(null);
    });
  });

  describe("name tag", () => {
    test("is shown with name", () => {
      render(<MediaView {...baseProps} displayName="Bob" />);
      expect(screen.getByTestId("name_tag")).toHaveTextContent("Bob");
    });
  });

  describe("waitingForMedia", () => {
    test("defaults to false", () => {
      render(<MediaView {...baseProps} />);
      expect(screen.queryAllByText("Waiting for media...").length).toBe(0);
    });
    test("shows and is accessible", async () => {
      const { container } = render(
        <TooltipProvider>
          <MediaView {...baseProps} waitingForMedia={true} />
        </TooltipProvider>,
      );
      expect(await axe(container)).toHaveNoViolations();
      expect(screen.getByText("Waiting for media...")).toBeVisible();
    });
  });

  describe("unencryptedWarning", () => {
    test("is shown and accessible", async () => {
      const { container } = render(
        <TooltipProvider>
          <MediaView {...baseProps} unencryptedWarning={true} />
        </TooltipProvider>,
      );
      expect(await axe(container)).toHaveNoViolations();
      expect(screen.getByRole("img", { name: "Not encrypted" })).toBeTruthy();
    });

    test("is shown and accessible even with name tag hidden", async () => {
      const { container } = render(
        <TooltipProvider>
          <MediaView {...baseProps} unencryptedWarning showNameTags={false} />
        </TooltipProvider>,
      );
      expect(await axe(container)).toHaveNoViolations();
      screen.getByRole("img", { name: "Not encrypted" });
    });

    test("is not shown", () => {
      render(
        <TooltipProvider>
          <MediaView {...baseProps} unencryptedWarning={false} />
        </TooltipProvider>,
      );
      expect(
        screen.queryAllByRole("img", { name: "Not encrypted" }).length,
      ).toBe(0);
    });
  });

  describe("videoEnabled", () => {
    test("just video is visible", () => {
      render(
        <TooltipProvider>
          <MediaView {...baseProps} videoEnabled={true} />
        </TooltipProvider>,
      );
      expect(screen.getByTestId("video")).toBeVisible();
      expect(screen.queryAllByRole("img", { name: "some name" }).length).toBe(
        0,
      );
    });

    test("just avatar is visible", () => {
      render(
        <TooltipProvider>
          <MediaView {...baseProps} videoEnabled={false} />
        </TooltipProvider>,
      );
      expect(
        screen.getByRole("img", { name: "@alice:example.com" }),
      ).toBeVisible();
      expect(screen.getByTestId("video")).not.toBeVisible();
    });
  });

  describe("leaving picture-in-picture", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** jsdom's media stubs ignore prototype spies, so pin it on the element. */
    function setPaused(video: HTMLElement, paused: boolean): void {
      Object.defineProperty(video, "paused", {
        get: () => paused,
        configurable: true,
      });
    }

    /** Fire the leave event as the browser does, targeted at the element. */
    function leavePictureInPicture(video: HTMLElement): void {
      video.dispatchEvent(
        new Event("leavepictureinpicture", { bubbles: true }),
      );
    }

    it("resumes a stream the close button paused", async () => {
      // Safari stops playback when picture-in-picture is dismissed with its
      // close button, which leaves a call tile frozen on the last frame while
      // the participant's audio carries on. There is nothing to resume to —
      // the stream is live — so playback has to be restarted.
      render(<MediaView {...baseProps} />);
      const video = screen.getByTestId("video");
      const play = vi
        .spyOn(video as HTMLVideoElement, "play")
        .mockResolvedValue(undefined);
      setPaused(video, true);

      leavePictureInPicture(video);
      await vi.waitFor(() => expect(play).toHaveBeenCalled());
    });

    it("leaves a still-playing stream alone", async () => {
      // Returning to the tab keeps playing; calling play() again would be
      // pointless churn on the element.
      render(<MediaView {...baseProps} />);
      const video = screen.getByTestId("video");
      const play = vi
        .spyOn(video as HTMLVideoElement, "play")
        .mockResolvedValue(undefined);
      setPaused(video, false);

      leavePictureInPicture(video);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(play).not.toHaveBeenCalled();
    });

    it("ignores an event from another tile's video", () => {
      // Several tiles mount this same document-level listener, so each has to
      // act only on its own element or one tile's PiP would restart another.
      render(<MediaView {...baseProps} />);
      const video = screen.getByTestId("video");
      setPaused(video, true);
      const play = vi
        .spyOn(video as HTMLVideoElement, "play")
        .mockResolvedValue(undefined);

      const otherVideo = document.createElement("video");
      document.body.appendChild(otherVideo);
      leavePictureInPicture(otherVideo);

      expect(play).not.toHaveBeenCalled();
      otherVideo.remove();
    });
  });
});
