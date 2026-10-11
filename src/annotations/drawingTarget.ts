/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Whether `target` is on a screen share that is being drawn on (an
 * AnnotationLayer with drawing on). Input there is a stroke: not a tap on the
 * call, nor a drag of the tile it is on.
 */
export function isOnDrawingLayer(target: EventTarget | null): boolean {
  // Not `instanceof Element`: an element from another window (a pop-out) is
  // not an instance of this one's Element.
  return (target as Element | null)?.closest?.("[data-drawing]") != null;
}
