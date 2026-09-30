import test from "node:test";
import assert from "node:assert/strict";
import { screenToDevicePoint, screenElementRect, elementAtPoint } from "../src/screen-mapping.js";
import type { ScreenElement } from "../src/elements.js";

test("touch positions use logical bounds when a 3x screenshot is displayed at half size", () => {
  const point = screenToDevicePoint({ x: 210, y: 289 }, { left: 100, top: 50, width: 220, height: 478 }, { width: 440, height: 956 });
  assert.deepEqual(point, { x: 220, y: 478 });
});

test("landscape input maps independently along both axes and clamps a drag outside the screen", () => {
  const screen = { left: 20, top: 40, width: 478, height: 220 };
  assert.deepEqual(screenToDevicePoint({ x: 259, y: 150 }, screen, { width: 956, height: 440 }), { x: 478, y: 220 });
  assert.deepEqual(screenToDevicePoint({ x: -10, y: 300 }, screen, { width: 956, height: 440 }), { x: 0, y: 439 });
  assert.equal(screenToDevicePoint({ x: 0, y: 0 }, { ...screen, width: 0 }, { width: 956, height: 440 }), undefined);
});

test("element highlights clip to visible screen bounds without changing scale", () => {
  assert.deepEqual(screenElementRect({ x: -10, y: 80, width: 30, height: 40 }, { width: 100, height: 100 }), { x: 0, y: 80, width: 20, height: 20 });
  assert.equal(screenElementRect({ x: 110, y: 0, width: 30, height: 40 }, { width: 100, height: 100 }), undefined);
});

test("Inspect selects the nested control rather than its surrounding cell", () => {
  const cell: ScreenElement = { ref: "e1", role: "Cell", label: "General", frame: { x: 10, y: 200, width: 400, height: 60 }, point: { x: 210, y: 230 } };
  const control: ScreenElement = { ref: "e2", role: "Button", label: "Info", frame: { x: 350, y: 210, width: 40, height: 40 }, point: { x: 370, y: 230 } };
  assert.equal(elementAtPoint([cell, control], { x: 370, y: 230 })?.ref, "e2");
  assert.equal(elementAtPoint([cell, control], { x: 100, y: 230 })?.ref, "e1");
  assert.equal(elementAtPoint([cell, control], { x: 0, y: 0 }), undefined);
});
