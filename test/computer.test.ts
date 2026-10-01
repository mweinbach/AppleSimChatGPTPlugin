import test from "node:test";
import assert from "node:assert/strict";
import { computerAction, computerInputs, computerTarget } from "../src/computer.js";

const sessionId = "16764887-9da3-43ed-85d4-a372838d5a70";

test("computer targets support CUA coordinates, indices, refs and accessibility selectors", () => {
  assert.deepEqual(computerTarget([20, 30]), { x: 20, y: 30 });
  assert.deepEqual(computerTarget(12, 4), { element: { ref: "e12" } });
  assert.deepEqual(computerTarget("e2", 4), { element: { ref: "e2" } });
  assert.deepEqual(computerTarget({ label: "General", role: "Button" }), { element: { label: "General", role: "Button" } });
  for (const target of [12, "e12", { ref: "e12" }]) assert.throws(() => computerTarget(target), /snapshot/);
});

test("simulator input is scoped and carries snapshot checks into the serial queue", () => {
  const result = computerAction("simulator_click", { sessionId, target: 12, snapshot: 4, clickCount: 2, settle: false });
  assert.deepEqual(result, { sessionId, action: { type: "tap", element: { ref: "e12" }, clickCount: 2 }, options: { simulatorOnly: true, accessibilityEnabled: true, screenshot: "auto", snapshot: 4, settle: false } });
  assert.equal(computerAction("simulator_click", { sessionId, target: [20, 30], screenshot: "always" }).options.screenshot, "always");
  assert.equal(computerInputs.simulator_click.safeParse({ sessionId, target: [20, 30], screenshot: "sometimes" }).success, false);
  assert.deepEqual(computerAction("simulator_type_text", { sessionId, target: [20, 30], text: "literal\\n🙂" }).action,
    { type: "type", x: 20, y: 30, text: "literal\\n🙂" });
  assert.deepEqual(computerAction("simulator_drag", { sessionId, from: [20, 100], to: [20, 30] }).action,
    { type: "swipe", x: 20, y: 100, toX: 20, toY: 30, duration: 0.4 });
  assert.deepEqual(computerAction("simulator_scroll", { sessionId, target: [20, 100], direction: "down" }).action,
    { type: "scroll", x: 20, y: 100, direction: "down", distance: 0.6 });
});

test("invalid targets, gestures and unsupported keys fail before simulator input", () => {
  for (const target of [0, -1, "e0", "window-1", {}, { role: "Button" }, [-1, 10], [10], [Infinity, 10]]) {
    assert.equal(computerInputs.simulator_click.safeParse({ sessionId, target }).success, false);
  }
  assert.throws(() => computerAction("simulator_click", { sessionId, target: "e1" }), /snapshot/);
  assert.equal(computerInputs.simulator_click.safeParse({ sessionId, target: [10, 10], clickCount: 2, duration: 1 }).success, false);
  assert.equal(computerInputs.simulator_drag.safeParse({ sessionId, from: [10, 10], to: [10, 20], duration: 8 }).success, false);
  assert.equal(computerInputs.simulator_press_key.safeParse({ sessionId, key: "super+c" }).success, false);
});
