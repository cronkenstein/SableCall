/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Host-media bridge for environments where the browser Fullscreen / PiP APIs
 * are incomplete (notably macOS WKWebView / Tauri).
 *
 * When element fullscreen fails inside the widget iframe, we ask the parent
 * (Sable) to fullscreen the call-room container — matching web/PWA behaviour
 * (call UI only, not the OS window).
 */

export const SABLE_CALL_HOST_SOURCE = "sable-call" as const;
export const SABLE_CALL_HOST_REPLY_SOURCE = "sable-call-host" as const;

export type SableCallHostFullscreenMessage = {
  source: typeof SABLE_CALL_HOST_SOURCE;
  action: "set-fullscreen";
  fullscreen: boolean;
};

export type SableCallHostFullscreenChangedMessage = {
  source: typeof SABLE_CALL_HOST_REPLY_SOURCE;
  action: "fullscreen-changed";
  fullscreen: boolean;
};

export function isDocumentFullscreen(): boolean {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function requestElementFullscreen(element: HTMLElement): Promise<boolean> {
  try {
    if (typeof element.requestFullscreen === "function") {
      await element.requestFullscreen();
      return true;
    }
    if (typeof element.webkitRequestFullscreen === "function") {
      element.webkitRequestFullscreen();
      return true;
    }
  } catch {
    // WKWebView often rejects element fullscreen for non-video elements.
  }
  return false;
}

async function exitElementFullscreen(): Promise<boolean> {
  try {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
      return true;
    }
    if (
      document.webkitFullscreenElement &&
      typeof document.webkitExitFullscreen === "function"
    ) {
      document.webkitExitFullscreen();
      return true;
    }
  } catch {
    // fall through to host delegation
  }
  return false;
}

function postHostFullscreen(fullscreen: boolean): void {
  const message: SableCallHostFullscreenMessage = {
    source: SABLE_CALL_HOST_SOURCE,
    action: "set-fullscreen",
    fullscreen,
  };
  // Prefer parent (widget iframe). Also notify self so a same-window host can listen.
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
  window.postMessage(message, "*");
}

/**
 * Toggle fullscreen. Returns whether we believe we are fullscreen afterwards.
 * When the browser API is unavailable, delegates to the host (call-room
 * fullscreen) and returns the requested state optimistically.
 */
export async function toggleHostAwareFullscreen(
  currentlyHostFullscreen: boolean,
): Promise<boolean> {
  const inBrowserFullscreen = isDocumentFullscreen();
  const currentlyFullscreen = inBrowserFullscreen || currentlyHostFullscreen;

  if (currentlyFullscreen) {
    if (inBrowserFullscreen) {
      await exitElementFullscreen();
    }
    if (currentlyHostFullscreen || !isDocumentFullscreen()) {
      postHostFullscreen(false);
    }
    return false;
  }

  // Prefer in-iframe fullscreen (works on web/PWA). Fall back to the host
  // fullscreening the call-room container when WKWebView rejects this.
  const entered = await requestElementFullscreen(document.documentElement);
  if (entered) return true;

  postHostFullscreen(true);
  return true;
}

/** Subscribe to host-driven call-room fullscreen changes (e.g. Escape). */
export function subscribeHostFullscreenChanges(
  onChange: (fullscreen: boolean) => void,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as Partial<SableCallHostFullscreenChangedMessage> | null;
    if (
      !data ||
      data.source !== SABLE_CALL_HOST_REPLY_SOURCE ||
      data.action !== "fullscreen-changed" ||
      typeof data.fullscreen !== "boolean"
    ) {
      return;
    }
    onChange(data.fullscreen);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

export async function enterPictureInPicture(
  video: HTMLVideoElement,
): Promise<void> {
  if (document.pictureInPictureElement === video) {
    await document.exitPictureInPicture();
    return;
  }
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
  }
  await video.requestPictureInPicture();
}
