import type { Rect, ScreenElement } from "./elements.js";

type Point = { x: number; y: number };
type Bounds = { width: number; height: number };

/** CSS pixels map to logical device points, independently of screenshot scale. */
export function screenToDevicePoint(point: Point, screen: { left: number; top: number; width: number; height: number }, bounds: Bounds): Point | undefined {
  if (screen.width <= 0 || screen.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return;
  return {
    x: Math.max(0, Math.min(bounds.width - 1, (point.x - screen.left) / screen.width * bounds.width)),
    y: Math.max(0, Math.min(bounds.height - 1, (point.y - screen.top) / screen.height * bounds.height)),
  };
}

/** Clip partially visible elements before positioning an overlay in percentages. */
export function screenElementRect(frame: Rect, bounds: Bounds): Rect | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(bounds.width, frame.x + frame.width);
  const bottom = Math.min(bounds.height, frame.y + frame.height);
  if (right <= left || bottom <= top) return;
  return { x: left / bounds.width * 100, y: top / bounds.height * 100, width: (right - left) / bounds.width * 100, height: (bottom - top) / bounds.height * 100 };
}

/** The smallest containing element avoids selecting a container over its control. */
export function elementAtPoint(elements: ScreenElement[], point: Point): ScreenElement | undefined {
  return elements.filter(({ frame }) => point.x >= frame.x && point.x <= frame.x + frame.width && point.y >= frame.y && point.y <= frame.y + frame.height)
    .sort((left, right) => left.frame.width * left.frame.height - right.frame.width * right.frame.height)[0];
}
