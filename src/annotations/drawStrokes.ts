/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  strokeColour,
  strokeOpacity,
  type Point,
  type Stroke,
} from "./strokes";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the shared picture is drawn inside its element, for `object-fit`
 * contain (letterboxed) or cover (cropped). Before the video has a size, the
 * whole element.
 */
export function pictureRect(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
  fit: "contain" | "cover",
): Rect {
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { x: 0, y: 0, width: elementWidth, height: elementHeight };
  }
  const scale =
    fit === "cover"
      ? Math.max(elementWidth / videoWidth, elementHeight / videoHeight)
      : Math.min(elementWidth / videoWidth, elementHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    x: (elementWidth - width) / 2,
    y: (elementHeight - height) / 2,
    width,
    height,
  };
}

/** A pointer position in the element, as a point on the shared picture. */
export function toPicturePoint(
  rect: Rect,
  elementX: number,
  elementY: number,
): Point {
  return {
    x: rect.width > 0 ? (elementX - rect.x) / rect.width : 0,
    y: rect.height > 0 ? (elementY - rect.y) / rect.height : 0,
  };
}

/**
 * Draws strokes onto `context` over the picture at `rect` (in canvas pixels).
 * Line width follows the picture's size, so a stroke looks the same weight on a
 * small tile and full screen.
 */
export function drawStrokes(
  context: CanvasRenderingContext2D,
  strokes: Stroke[],
  rect: Rect,
  now: number,
): void {
  const lineWidth = Math.max(2, rect.width * 0.0045);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    const opacity = strokeOpacity(stroke, now);
    if (opacity <= 0 || stroke.points.length === 0) continue;
    context.globalAlpha = opacity;
    context.strokeStyle = strokeColour(stroke.sender);
    context.fillStyle = context.strokeStyle;
    context.lineWidth = lineWidth;
    // A dark edge, so a stroke reads on a light screen as well as a dark one.
    context.shadowColor = "rgba(0, 0, 0, 0.55)";
    context.shadowBlur = lineWidth;

    const [first, ...rest] = stroke.points;
    const fx = rect.x + first.x * rect.width;
    const fy = rect.y + first.y * rect.height;
    if (rest.length === 0) {
      context.beginPath();
      context.arc(fx, fy, lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(fx, fy);
    for (const point of rest) {
      context.lineTo(
        rect.x + point.x * rect.width,
        rect.y + point.y * rect.height,
      );
    }
    context.stroke();
  }
  context.globalAlpha = 1;
  context.shadowBlur = 0;
}
