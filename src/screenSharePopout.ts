/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { RemoteVideoTrack, type ElementInfo, type Track } from "livekit-client";
import { logger } from "matrix-js-sdk/lib/logger";

/**
 * The URL the host recognises (see the `popoutWindow` URL flag): Sable's main
 * window turns a `window.open` of it into a small always-on-top window.
 */
export const SCREEN_SHARE_POPOUT_URL = "about:blank#sable-popout";
const POPOUT_NAME = "sable-screen-share";
const POPOUT_MAX_WIDTH = 640;
const CLOSED_POLL_MS = 500;

export interface ScreenSharePopout {
  /** The pop-out's window, while it is open. */
  readonly window: Window;
  /** Shows a different track, when the share is restarted under it. */
  setTrack(track: Track): void;
  close(): void;
}

let current: ScreenSharePopout | null = null;

/** The screen share currently popped out, if any. */
export function currentScreenSharePopout(): ScreenSharePopout | null {
  return current && !current.window.closed ? current : null;
}

/**
 * Tells LiveKit's adaptive stream that the share is being watched in the
 * pop-out, at the pop-out's size. Without it the subscription is paused as soon
 * as the call's own window is hidden — minimised, which is exactly when a
 * pop-out is being used — because LiveKit only sees elements in its own
 * document. Marked as picture in picture, which is what it is, and which keeps
 * the video flowing in the background.
 */
function watchInPopout(
  track: Track,
  video: HTMLVideoElement,
  popup: Window,
): () => void {
  if (!(track instanceof RemoteVideoTrack)) return (): void => {};
  const info: ElementInfo = {
    element: video,
    width: () => video.clientWidth,
    height: () => video.clientHeight,
    visible: true,
    pictureInPicture: true,
    visibilityChangedAt: Date.now(),
    observe: (): void => {
      popup.addEventListener("resize", onResize);
    },
    stopObserving: (): void => {
      popup.removeEventListener("resize", onResize);
    },
  };
  function onResize(): void {
    info.handleResize?.();
  }
  track.observeElementInfo(info);
  return (): void => track.stopObservingElementInfo(info);
}

function popoutSize(source: HTMLVideoElement): {
  width: number;
  height: number;
} {
  const aspect =
    source.videoWidth > 0 && source.videoHeight > 0
      ? source.videoWidth / source.videoHeight
      : 16 / 9;
  const width = Math.min(
    POPOUT_MAX_WIDTH,
    source.videoWidth || POPOUT_MAX_WIDTH,
  );
  return { width, height: Math.round(width / aspect) };
}

/**
 * Pops a screen share out into its own window, which the host keeps on top of
 * everything else. Only the shared content goes: the call stays where it is.
 *
 * The window is same-origin and empty, and filled from here: the share's own
 * MediaStreamTrack plays in it, so there is no second decode or re-encode.
 * Returns null when the window could not be opened.
 */
export function openScreenSharePopout(
  track: Track,
  source: HTMLVideoElement,
  title: string,
  onClosed: () => void,
): ScreenSharePopout | null {
  current?.close();

  const { width, height } = popoutSize(source);
  const popup = window.open(
    SCREEN_SHARE_POPOUT_URL,
    POPOUT_NAME,
    `popup,width=${width},height=${height}`,
  );
  if (!popup) {
    logger.warn("Screen share pop-out: the window could not be opened");
    return null;
  }
  // Narrowed for the closures below, which TypeScript does not follow.
  const openedWindow: Window = popup;

  const doc = popup.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent =
    "html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
    "video{display:block;width:100%;height:100%;object-fit:contain}";
  doc.head.appendChild(style);
  const video = doc.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  doc.body.replaceChildren(video);

  let stopWatching = (): void => {};
  let shownTrack: Track | null = null;
  const show = (next: Track): void => {
    if (next === shownTrack) return;
    stopWatching();
    shownTrack = next;
    video.srcObject = new MediaStream([next.mediaStreamTrack]);
    void video.play().catch(() => {
      // Autoplay of a muted video is allowed; a failure here is transient.
    });
    stopWatching = watchInPopout(next, video, popup);
  };
  show(track);

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    window.clearInterval(poll);
    window.removeEventListener("pagehide", close);
    stopWatching();
    video.srcObject = null;
    if (current === handle) current = null;
    onClosed();
  };
  function close(): void {
    if (!openedWindow.closed) openedWindow.close();
    finish();
  }
  // Closed by the user: a window has no reliable event for that across hosts.
  // And the share ending: LiveKit stops a remote track without an event.
  const poll = window.setInterval(() => {
    if (popup.closed) finish();
    else if (shownTrack?.mediaStreamTrack.readyState === "ended") close();
  }, CLOSED_POLL_MS);
  // The call going away takes the pop-out with it.
  window.addEventListener("pagehide", close);

  const handle: ScreenSharePopout = {
    window: popup,
    setTrack: show,
    close,
  };
  current = handle;
  return handle;
}
