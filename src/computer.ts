import { z } from "zod";
import { elementTargetSchema, screenshotModeSchema, type DeviceAction, type ElementTarget, type ScreenshotMode } from "./shared.js";

const point = z.number().finite().nonnegative();
/** Coordinates and numeric element indices follow the simulator's current observation. */
export const computerTargetSchema = z.union([
  z.tuple([point, point]),
  z.number().int().positive(),
  z.string().regex(/^e[1-9]\d*$/),
  elementTargetSchema.refine(value => !!(value.ref || value.label || value.identifier), "Choose an element ref, label, or identifier."),
]).describe("A logical [x,y] point, element number, e-ref, or accessibility selector. Element numbers and refs require the snapshot from simulator_get_state.");
export type ComputerTarget = z.infer<typeof computerTargetSchema>;

const sessionId = z.string().uuid();
export const screenshotOption = screenshotModeSchema.default("auto").describe("\"auto\" attaches a screenshot only when the element list cannot describe the screen; \"always\" attaches one for visual checks; \"never\" returns text only.");
const snapshot = z.number().int().positive().optional().describe("Snapshot from simulator_get_state; required when using an element number or ref. Stale snapshots are rejected before input.");
const actionOptions = {
  sessionId, snapshot, screenshot: screenshotOption,
  settle: z.boolean().optional().describe("Wait for animations before returning the resulting screen and accessibility state (default true)."),
};
export const computerInputs = {
  simulator_get_state: z.object({ sessionId, screenshot: screenshotOption }),
  simulator_screenshot: z.object({ sessionId }),
  simulator_click: z.object({ ...actionOptions, target: computerTargetSchema, clickCount: z.union([z.literal(1), z.literal(2)]).default(1), duration: z.number().min(0.1).max(5).optional().describe("Hold duration in seconds for a long press; omit for an ordinary click.") })
    .refine(value => value.clickCount === 1 || value.duration === undefined, "A double click cannot also be a long press."),
  simulator_drag: z.object({ ...actionOptions, from: z.tuple([point, point]), to: z.tuple([point, point]), duration: z.number().min(0.1).max(5).default(0.4) }),
  simulator_scroll: z.object({ ...actionOptions, target: computerTargetSchema.optional(), direction: z.enum(["up", "down", "left", "right"]), distance: z.number().min(0.1).max(1).default(0.6) }),
  simulator_type_text: z.object({ ...actionOptions, target: computerTargetSchema.optional(), text: z.string().min(1).max(10000) }),
  simulator_press_key: z.object({ ...actionOptions, key: z.enum(["Return", "Tab", "Backspace", "Home", "Lock", "VolumeUp", "VolumeDown"]) }),
};
export type ComputerToolName = keyof typeof computerInputs;

export function computerTarget(target: ComputerTarget, snapshot?: number): { x: number; y: number } | { element: ElementTarget } {
  if (Array.isArray(target)) return { x: target[0], y: target[1] };
  const element = typeof target === "number" ? { ref: `e${target}` } : typeof target === "string" ? { ref: target } : target;
  if (element.ref && snapshot === undefined) throw new Error("Element numbers and refs require the snapshot from simulator_get_state. Observe again before clicking.");
  return { element };
}

export function computerAction(name: ComputerToolName, args: unknown): {
  sessionId: string;
  action: DeviceAction;
  options: { simulatorOnly: true; accessibilityEnabled: true; screenshot: ScreenshotMode; snapshot?: number; settle?: boolean };
} {
  const input = z.object(actionOptions).parse(args);
  const options = { simulatorOnly: true as const, accessibilityEnabled: true as const, screenshot: input.screenshot, ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}), ...(input.settle !== undefined ? { settle: input.settle } : {}) };
  let action: DeviceAction;
  switch (name) {
    case "simulator_click": {
      const value = computerInputs.simulator_click.parse(args);
      action = { type: "tap", ...computerTarget(value.target, value.snapshot), clickCount: value.clickCount, ...(value.duration !== undefined ? { duration: value.duration } : {}) };
      break;
    }
    case "simulator_drag": {
      const value = computerInputs.simulator_drag.parse(args);
      action = { type: "swipe", x: value.from[0], y: value.from[1], toX: value.to[0], toY: value.to[1], duration: value.duration };
      break;
    }
    case "simulator_scroll": {
      const value = computerInputs.simulator_scroll.parse(args);
      action = { type: "scroll", direction: value.direction, distance: value.distance, ...(value.target !== undefined ? computerTarget(value.target, value.snapshot) : {}) };
      break;
    }
    case "simulator_type_text": {
      const value = computerInputs.simulator_type_text.parse(args);
      const target = value.target !== undefined ? computerTarget(value.target, value.snapshot) : undefined;
      action = { type: "type", text: value.text, ...target };
      break;
    }
    case "simulator_press_key": {
      const value = computerInputs.simulator_press_key.parse(args);
      action = { type: "pressKey", key: value.key };
      break;
    }
    default: throw new Error("Observation tools do not perform input.");
  }
  return { sessionId: input.sessionId, action, options };
}
