import { z } from "zod";
import type { ScreenElement } from "./elements.js";

/** Tool results carry the raw accessibility tree here for the viewer, outside model context. */
export const HIERARCHY_META_KEY = "apple-device-hub/hierarchy";
/**
 * Results the model also reads carry the viewer's structured state here.
 * Codex gives models only structuredContent when a result has it, dropping
 * the element list and screenshot, so those results return text and images.
 */
export const DATA_META_KEY = "apple-device-hub/data";

export const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["simulator", "device"]),
  platform: z.string(),
  runtime: z.string(),
  state: z.string(),
  available: z.boolean(),
  /** A simulator Device Hub created, which simulator_delete may remove. */
  createdByHub: z.boolean().optional(),
});
export type Device = z.infer<typeof deviceSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  device: deviceSchema,
  accessibilityEnabled: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;

/** A device session another Device Hub server holds, such as another chat or window. */
export interface SharedDevice {
  deviceId: string;
  deviceName: string;
  /** Device Hub servers sharing it. */
  holders: number;
  /** The session was started by another tool and joined with takeOver. */
  otherTool?: boolean;
}

/** The device most recently connected by any Device Hub server; viewers follow it. */
export interface DeviceFocus { deviceId: string; deviceName: string; at: string }

/** How device_connect obtained its session. */
export type SessionOrigin = "new" | "this-server" | "device-hub" | "other-tool";
export type ConnectedSession = Session & { origin: SessionOrigin };

export interface HubState {
  devices: Device[];
  sessions: Session[];
  warnings: string[];
  elsewhere?: SharedDevice[];
  focus?: DeviceFocus;
}

export interface Screenshot {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  width: number;
  height: number;
}

/** "auto" attaches an image only when the element list cannot describe the screen. */
export const screenshotModeSchema = z.enum(["auto", "always", "never"]);
export type ScreenshotMode = z.infer<typeof screenshotModeSchema>;

export interface Capture {
  session: Session;
  capturedAt: string;
  /** Absent when the caller's screenshot mode left the image out. */
  screenshot?: Screenshot;
  coordinateSpace: { width: number; height: number };
  hierarchy?: string;
  applicationState?: string;
  deviceOrientation?: string;
  settings?: DeviceSettings;
  /** Changes with elements or device coordinates/orientation, so refs stay valid across identical captures. */
  snapshot?: number;
  bundleId?: string;
  elements?: ScreenElement[];
  /** On live frames: another device the agent connected since; the viewer follows it. */
  focus?: DeviceFocus;
}

export type CaptureState = Omit<Capture, "screenshot" | "elements"> & {
  screenshot?: Omit<Screenshot, "data">;
};

const point = z.number().finite().nonnegative();
export const elementTargetSchema = z.object({
  ref: z.string().regex(/^e\d+$/).optional().describe("Element ref from the latest element list, e.g. \"e12\""),
  label: z.string().min(1).max(500).optional().describe("Accessibility label, exact match first, then substring"),
  identifier: z.string().min(1).max(500).optional().describe("Accessibility identifier"),
  role: z.string().min(1).max(60).optional().describe("Narrow a label/identifier match to a role such as Button or TextField"),
  index: z.number().int().nonnegative().optional().describe("Pick among several matches, in list order"),
});
export type ElementTarget = z.infer<typeof elementTargetSchema>;
const coordinateTarget = (action: { x?: number; y?: number; element?: ElementTarget }) =>
  (action.x === undefined) === (action.y === undefined) && !(action.element && action.x !== undefined);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: point.optional(), y: point.optional(), element: elementTargetSchema.optional(), clickCount: z.union([z.literal(1), z.literal(2)]).optional(), duration: z.number().min(0.1).max(5).optional() })
    .refine(coordinateTarget, "Provide an element target or both x and y.")
    .refine(action => action.clickCount !== 2 || action.duration === undefined, "A double tap cannot also have a hold duration."),
  z.object({ type: z.literal("swipe"), x: point, y: point, toX: point, toY: point, duration: z.number().min(0.1).max(5).default(0.4) }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), x: point.optional(), y: point.optional(), element: elementTargetSchema.optional(), distance: z.number().min(0.1).max(1).default(0.6) })
    .refine(coordinateTarget, "Provide an element target or both x and y."),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(10000), x: point.optional(), y: point.optional(), element: elementTargetSchema.optional() })
    .refine(coordinateTarget, "Provide an element target or both x and y."),
  z.object({ type: z.literal("pressKey"), key: z.enum(["Return", "Tab", "Backspace", "Home", "Lock", "VolumeUp", "VolumeDown"]) }),
  z.object({ type: z.literal("button"), button: z.enum(["home", "lock", "volumeUp", "volumeDown"]) }),
  z.object({ type: z.literal("orientation"), orientation: z.enum(["portrait", "landscapeLeft", "landscapeRight", "portraitUpsideDown"]) }),
  z.object({ type: z.literal("openSettings") }),
  z.object({ type: z.literal("launchApp"), bundleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/).max(255) }),
]);
export type DeviceAction = z.infer<typeof actionSchema>;

const fraction = z.number().finite().min(0).max(1);
const elapsed = z.number().finite().min(0).max(1000).default(0).describe("Milliseconds since the previous live input event");
/** A device action performed through MCP tools, shown on the live viewer. Points are logical. */
export interface DeviceActivity {
  id: number;
  at: string;
  summary: string;
  ref?: string;
  point?: { x: number; y: number };
  to?: { x: number; y: number };
}

/** Live simulator input; x and y are fractions of the displayed video frame. */
export const liveInputSchema = z.union([
  z.object({ type: z.enum(["down", "move", "up", "cancel"]), x: fraction, y: fraction, dt: elapsed }),
  z.object({ type: z.literal("home"), dt: elapsed }),
]);
export type LiveInput = z.infer<typeof liveInputSchema>;

export const textSizeSchema = z.enum(["extra-small", "small", "medium", "large", "extra-large", "extra-extra-large", "extra-extra-extra-large", "accessibility-medium", "accessibility-large", "accessibility-extra-large", "accessibility-extra-extra-large", "accessibility-extra-extra-extra-large"]);
export const settingsSchema = z.object({
  appearance: z.enum(["light", "dark"]).optional(),
  textSize: textSizeSchema.optional(),
  reduceMotion: z.boolean().optional(),
  reduceTransparency: z.boolean().optional(),
  increasedContrast: z.boolean().optional(),
});
export type DeviceSettings = z.infer<typeof settingsSchema>;
