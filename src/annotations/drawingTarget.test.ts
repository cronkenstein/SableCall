/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { isOnDrawingLayer } from "./drawingTarget";

describe("isOnDrawingLayer", () => {
  it("is true inside a layer with drawing on", () => {
    const layer = document.createElement("div");
    layer.setAttribute("data-drawing", "true");
    const canvas = document.createElement("canvas");
    layer.appendChild(canvas);
    expect(isOnDrawingLayer(canvas)).toBe(true);
    expect(isOnDrawingLayer(layer)).toBe(true);
  });

  it("is false on a layer with drawing off, and elsewhere", () => {
    const layer = document.createElement("div");
    const canvas = document.createElement("canvas");
    layer.appendChild(canvas);
    expect(isOnDrawingLayer(canvas)).toBe(false);
    expect(isOnDrawingLayer(null)).toBe(false);
    expect(isOnDrawingLayer(window)).toBe(false);
  });
});
