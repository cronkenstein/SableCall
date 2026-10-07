/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  createContext,
  type FC,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";

import { type AnnotationBus, type LocalStroke } from "./AnnotationBus";
import { drawStrokes, pictureRect, toPicturePoint } from "./drawStrokes";
import styles from "./AnnotationLayer.module.css";

/** The call's annotation bus, where there is a call to draw in. */
export const AnnotationContext = createContext<AnnotationBus | null>(null);

export const useAnnotationBus = (): AnnotationBus | null =>
  useContext(AnnotationContext);

interface Props {
  /** Whose screen share this is: the sharer's LiveKit identity. */
  shareKey: string;
  /** Whether pointer input draws, or passes through to the tile. */
  drawing: boolean;
  fit: "contain" | "cover";
}

/**
 * Everyone's strokes over a screen share, and drawing new ones while `drawing`.
 * Sits over the tile's video, which it measures to find the picture.
 */
export const AnnotationLayer: FC<Props> = ({
  shareKey,
  drawing,
  fit,
}): ReactNode => {
  const bus = useAnnotationBus();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokeRef = useRef<LocalStroke | null>(null);

  const measure = (): {
    rect: ReturnType<typeof pictureRect>;
    width: number;
    height: number;
  } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const video = canvas.parentElement?.parentElement?.querySelector("video");
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    return {
      rect: pictureRect(
        width,
        height,
        video?.videoWidth ?? 0,
        video?.videoHeight ?? 0,
        fit,
      ),
      width,
      height,
    };
  };

  // Redraw while there is anything to show; stop once it has all faded.
  useEffect(() => {
    if (!bus) return;
    let frame = 0;
    const paint = (): void => {
      frame = 0;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const measured = measure();
      if (!canvas || !context || !measured) return;
      const ratio = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(measured.width * ratio);
      const pixelHeight = Math.round(measured.height * ratio);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, measured.width, measured.height);
      const now = performance.now();
      const strokes = bus.store.visible(shareKey, now);
      drawStrokes(context, strokes, measured.rect, now);
      if (strokes.length > 0) frame = requestAnimationFrame(paint);
    };
    const schedule = (): void => {
      frame ||= requestAnimationFrame(paint);
    };
    const unsubscribe = bus.store.subscribe(schedule);
    schedule();
    return (): void => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
    // measure reads refs and `fit`; the effect only needs to restart for these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, shareKey, fit]);

  // Leaving draw mode mid-stroke finishes the stroke.
  useEffect(() => {
    if (!drawing) {
      strokeRef.current?.finish();
      strokeRef.current = null;
    }
  }, [drawing]);

  if (!bus) return null;

  const pointFor = (
    e: PointerEvent<HTMLCanvasElement>,
  ): ReturnType<typeof toPicturePoint> | null => {
    const measured = measure();
    if (!measured) return null;
    const bounds = e.currentTarget.getBoundingClientRect();
    return toPicturePoint(
      measured.rect,
      e.clientX - bounds.left,
      e.clientY - bounds.top,
    );
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!drawing || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    strokeRef.current?.finish();
    strokeRef.current = bus.beginStroke(shareKey);
    const point = pointFor(e);
    if (point) strokeRef.current?.addPoint(point);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!strokeRef.current) return;
    const point = pointFor(e);
    if (point) strokeRef.current.addPoint(point);
  };
  const onPointerEnd = (): void => {
    strokeRef.current?.finish();
    strokeRef.current = null;
  };

  return (
    <div className={styles.layer} data-drawing={drawing || undefined}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
    </div>
  );
};
