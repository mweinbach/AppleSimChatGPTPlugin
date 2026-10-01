import { execFile } from 'node:child_process';
import { version } from './version.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { resolveElement, summarizeHierarchy, type Rect, type ScreenElement } from './elements.js';
import { actionSchema, settingsSchema, textSizeSchema, type Capture, type ConnectedSession, type Device, type DeviceAction, type DeviceActivity, type DeviceFocus, type DeviceSettings, type ElementTarget, type HubState, type LiveInput, type ScreenshotMode, type Session, type SessionOrigin } from './shared.js';
import { SessionRegistry } from './session-registry.js';
import { SimulatorVideo, type VideoBatch, type VideoStream } from './video.js';

/** Every Device Hub session name starts with this, so another server can recognize one left by a crashed server. */
const SESSION_LABEL = 'Apple Device Hub';

/** Xcode answers ordinary requests in well under a second. */
const XCODE_TIMEOUT_MS = 40_000;
/** The first observation of a shut-down simulator boots it. Codex allows tools 300 s. */
const BOOT_TIMEOUT_MS = 100_000;
/** Ordinary requests return within MCP clients' common 60 s request timeout, even behind a stuck one. */
const OPERATION_DEADLINE_MS = 55_000;

export interface AppleBoundary {
  command(args: string[], timeoutMs?: number): Promise<string>;
  tool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Re-encodes a screenshot as a JPEG no larger than maxEdge pixels on its long side. */
  compress?(input: string, output: string, maxEdge: number): Promise<void>;
  close(): Promise<void>;
}

const execFileAsync = promisify(execFile);

/** One reusable connection to Apple's supported local MCP service. */
export class NativeAppleBoundary implements AppleBoundary {
  private client?: Promise<Client>;
  private stderr = '';

  async command(args: string[], timeoutMs = 30_000): Promise<string> {
    const result = await execFileAsync('/usr/bin/xcrun', args, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  }

  async compress(input: string, output: string, maxEdge: number): Promise<void> {
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '65', '-Z', String(maxEdge), input, '--out', output], { timeout: 10_000 });
  }

  private async connect(): Promise<Client> {
    if (!this.client) {
      this.client = (async () => {
        const client = new Client({ name: 'apple-device-hub', version }, { capabilities: {} });
        client.onclose = () => { this.client = undefined; };
        const transport = new StdioClientTransport({ command: '/usr/bin/xcrun', args: ['mcpbridge'], stderr: 'pipe' });
        transport.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
        try {
          await client.connect(transport, { timeout: 60_000 });
          return client;
        } catch (error) {
          await transport.close();
          throw new Error(timedOut(error)
            ? 'Xcode did not accept the connection. If Xcode is asking whether to allow access, choose Allow; otherwise turn on Xcode Settings > Intelligence > Model Context Protocol, then retry.'
            : `Could not connect to Xcode MCP. Turn on Xcode Settings > Intelligence > Model Context Protocol, then retry. ${this.stderr || String(error)}`);
        }
      })();
    }
    try {
      return await this.client;
    } catch (error) {
      this.client = undefined;
      throw error;
    }
  }

  async tool(name: string, args: Record<string, unknown>, timeoutMs = XCODE_TIMEOUT_MS): Promise<unknown> {
    const client = await this.connect();
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (error) {
      if (timedOut(error)) throw new Error(`Xcode did not answer within ${timeoutMs / 1000} s. Make sure Xcode is open and not showing a dialog, then try again.`);
      throw error;
    }
  }

  async close(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    if (pending) await (await pending).close();
  }
}

const timedOut = (error: unknown) => error instanceof McpError && error.code === ErrorCode.RequestTimeout;

type ObjectValue = Record<string, any>;

/** Apple returns structuredContent; text JSON also supports its older bridge releases. */
export function appleToolData(result: unknown): ObjectValue {
  const response = result as ObjectValue;
  const text = (response.content ?? []).filter((item: ObjectValue) => item.type === 'text').map((item: ObjectValue) => item.text).join('\n');
  if (response.isError) {
    // Xcode wraps errors as {"type":"error","data":"…"}.
    let message = text;
    try { const parsed = JSON.parse(text) as ObjectValue; if (typeof parsed.data === 'string') message = parsed.data; } catch { /* plain text */ }
    throw new Error(message || 'Xcode device interaction failed.');
  }
  if (response.structuredContent) return response.structuredContent as ObjectValue;
  try {
    return JSON.parse(text) as ObjectValue;
  } catch {
    throw new Error(text || 'Xcode returned no device interaction data.');
  }
}

export function pngDimensions(image: Buffer): { width: number; height: number } {
  if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Device capture did not return a PNG image.');
  }
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

export function jpegDimensions(image: Buffer): { width: number; height: number } {
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8) throw new Error('Device capture did not return a JPEG image.');
  let offset = 2;
  while (offset + 9 < image.length) {
    if (image[offset] !== 0xff) { offset++; continue; }
    const marker = image[offset + 1]!;
    // Start-of-frame markers carry the dimensions; C4, C8 and CC share the range but are tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: image.readUInt16BE(offset + 7), height: image.readUInt16BE(offset + 5) };
    }
    offset += 2 + image.readUInt16BE(offset + 2);
  }
  throw new Error('Device capture JPEG has no frame header.');
}

export function imageInfo(image: Buffer): { mimeType: 'image/png' | 'image/jpeg'; width: number; height: number } {
  return image[0] === 0xff && image[1] === 0xd8 ? { mimeType: 'image/jpeg', ...jpegDimensions(image) } : { mimeType: 'image/png', ...pngDimensions(image) };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The part of the screen a scroll gesture uses: the element's visible frame, or the screen clear of system bars. */
export function scrollRegion(frame: Rect | undefined, bounds: { width: number; height: number }): Rect {
  const area = frame ?? { x: 0, y: bounds.height * 0.15, width: bounds.width, height: bounds.height * 0.7 };
  const x = Math.max(0, area.x);
  const y = Math.max(0, area.y);
  const right = Math.min(bounds.width - 1, area.x + area.width);
  const bottom = Math.min(bounds.height - 1, area.y + area.height);
  if (right - x < 10 || bottom - y < 10) throw new Error('The scroll target is not visible on screen.');
  return { x, y, width: right - x, height: bottom - y };
}

/** Scroll directions follow the content: "down" reveals content below, so the finger moves up. */
export function scrollGesture(region: Rect, direction: 'up' | 'down' | 'left' | 'right', distance: number) {
  const center = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
  const vertical = direction === 'up' || direction === 'down';
  const span = (vertical ? region.height : region.width) * Math.min(distance, 0.9) / 2;
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const from = vertical ? { x: center.x, y: center.y + sign * span } : { x: center.x + sign * span, y: center.y };
  const to = vertical ? { x: center.x, y: center.y - sign * span } : { x: center.x - sign * span, y: center.y };
  return { from: { x: round(from.x), y: round(from.y) }, to: { x: round(to.x), y: round(to.y) } };
}

/** Coordinate scrolls start at the requested point, just as a computer-use pointer does. */
export function scrollFromPoint(from: { x: number; y: number }, bounds: { width: number; height: number }, direction: 'up' | 'down' | 'left' | 'right', distance: number) {
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'down' || direction === 'right' ? -1 : 1;
  const span = (vertical ? bounds.height * 0.7 : bounds.width) * Math.min(distance, 0.9);
  const to = vertical
    ? { x: from.x, y: Math.max(0, Math.min(bounds.height - 1, from.y + sign * span)) }
    : { x: Math.max(0, Math.min(bounds.width - 1, from.x + sign * span)), y: from.y };
  if (from.x === to.x && from.y === to.y) throw new Error('The scroll origin leaves no room to move in that direction. Choose another point.');
  return { from, to };
}

export function keyboardCommand(text: string): string {
  // The native keyboard grammar treats Unicode escape sequences specially.
  // Encoding every scalar makes literal backslashes, newlines and spaces unambiguous.
  return 'sender keyboard kbd ' + Array.from(text, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`).join('');
}

export function logicalDimensions(hierarchy: string, image?: { width: number; height: number }): { width: number; height: number } {
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const frame = new RegExp(`\\{\\{\\s*(${number})\\s*,\\s*(${number})\\s*\\},\\s*\\{\\s*(${number})\\s*,\\s*(${number})\\s*\\}\\}`);
  const lines = hierarchy.split('\n');
  // Child views can be off-screen or have rotated frames. Prefer the window,
  // which defines the coordinate system used by Apple's event synthesizer.
  const windows = lines.filter((line) => /^\s*(?:UIWindow|Window)\b/.test(line)).map((line) => line.match(frame)).filter((match) =>
    match && Number(match[1]) === 0 && Number(match[2]) === 0 && Number(match[3]) > 0 && Number(match[4]) > 0,
  ).map((match) => ({ width: Number(match![3]), height: Number(match![4]) })).filter((bounds) =>
    !image || Math.abs(bounds.width / bounds.height - image.width / image.height) < 0.02,
  ).sort((a, b) => b.width * b.height - a.width * a.height);
  if (!windows[0]) {
    throw new Error('Xcode did not expose the device window bounds. Capture the accessibility hierarchy again before using touch controls.');
  }
  return windows[0];
}

export function simulatorDevices(json: string): Device[] {
  const result = JSON.parse(json) as { devices: Record<string, ObjectValue[]> };
  return Object.entries(result.devices).flatMap(([identifier, devices]) => {
    const runtime = identifier.match(/\.([A-Za-z]+)-([\d-]+)$/);
    const platform = runtime?.[1] ?? identifier;
    return devices.map((device) => ({
      id: device.udid, name: device.name, kind: 'simulator' as const,
      platform, runtime: `${platform} ${runtime?.[2]?.replaceAll('-', '.') ?? ''}`.trim(),
      state: device.state, available: device.isAvailable === true,
    }));
  });
}

const versionParts = (version: unknown) => String(version ?? '0').split('.').map(Number);
const newerFirst = (left: unknown, right: unknown) => {
  const [a, b] = [versionParts(left), versionParts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
  return 0;
};

/**
 * Resolves a device type name such as "iPhone 17 Pro", and optionally a
 * runtime such as "iOS 27.2", "iOS 27" or "27.2", against `simctl list
 * runtimes -j`. Without a runtime, the newest one supporting the type wins.
 */
export function resolveSimulatorType(json: string, deviceType: string, runtime?: string): { deviceType: { name: string; identifier: string }; runtime: { name: string; identifier: string } } {
  const runtimes = ((JSON.parse(json) as { runtimes?: ObjectValue[] }).runtimes ?? []).filter(item => item.isAvailable);
  const wantedRuntime = runtime?.trim().toLowerCase();
  const matching = runtimes.filter(item => !wantedRuntime
    || [item.name, item.identifier, item.version, item.platform].some(value => typeof value === 'string' && value.toLowerCase() === wantedRuntime)
    || String(item.name ?? '').toLowerCase().startsWith(`${wantedRuntime}.`));
  if (!matching.length) throw new Error(`No installed simulator runtime matches “${runtime}”. Installed: ${runtimes.map(item => item.name).join(', ') || 'none'}.`);
  const wanted = deviceType.trim().toLowerCase();
  const found = matching
    .flatMap(item => (item.supportedDeviceTypes ?? [] as ObjectValue[])
      .filter((type: ObjectValue) => String(type.name).toLowerCase() === wanted || String(type.identifier).toLowerCase() === wanted)
      .map((type: ObjectValue) => ({ runtime: item, type })))
    .sort((left, right) => newerFirst(left.runtime.version, right.runtime.version))[0];
  if (!found) {
    const names = [...new Set(matching.flatMap(item => (item.supportedDeviceTypes ?? []).map((type: ObjectValue) => type.name as string)))];
    throw new Error(`“${deviceType}” is not a simulator type for ${runtime ?? 'the installed runtimes'}. Choose one of: ${names.join(', ')}.`);
  }
  return { deviceType: { name: found.type.name, identifier: found.type.identifier }, runtime: { name: found.runtime.name, identifier: found.runtime.identifier } };
}

export function physicalDevices(json: string): Device[] {
  const result = JSON.parse(json) as { result: { devices: ObjectValue[] } };
  return result.result.devices.filter((device) => {
    const hardware = device.properties?.hardware ?? device.hardwareProperties;
    return hardware?.reality !== 'simulated';
  }).map((device) => {
    const properties = device.properties ?? {};
    const hardware = properties.hardware ?? device.hardwareProperties ?? {};
    const state = properties.state ?? device.deviceProperties ?? {};
    const connection = properties.connection ?? device.connectionProperties ?? {};
    const version = properties.software?.osVersionNumber?.stringValue ?? device.deviceProperties?.osVersionNumber ?? '';
    const connectionState = connection.state ?? connection.tunnelState ?? 'unavailable';
    return {
      id: hardware.udid ?? device.identifier,
      name: state.name ?? hardware.marketingName ?? device.identifier,
      kind: 'device' as const, platform: hardware.platform ?? 'iOS',
      runtime: `${hardware.platform ?? 'iOS'} ${version}`.trim(),
      state: connectionState,
      available: connection.pairingState === 'paired' && connectionState !== 'unavailable',
    };
  });
}

export function appearanceSettings(json: string): DeviceSettings | undefined {
  const appearance = (JSON.parse(json) as ObjectValue).result;
  if (!appearance) return undefined;
  const settings: DeviceSettings = {};
  if (appearance.userInterfaceStyle === 'light' || appearance.userInterfaceStyle === 'dark') settings.appearance = appearance.userInterfaceStyle;
  if (typeof appearance.textSize === 'string') {
    const size = textSizeSchema.safeParse(appearance.textSize.trim().toLowerCase().replace(/[\s_]+/g, '-'));
    if (size.success) settings.textSize = size.data;
  }
  if (typeof appearance.increaseContrast === 'boolean') settings.increasedContrast = appearance.increaseContrast;
  if (typeof appearance.reduceMotion?.enabled === 'boolean') settings.reduceMotion = appearance.reduceMotion.enabled;
  if (typeof appearance.reduceTransparency?.enabled === 'boolean') settings.reduceTransparency = appearance.reduceTransparency.enabled;
  return Object.keys(settings).length ? settings : undefined;
}

interface NativeSession {
  public: Session;
  /** Xcode's session key, which is also its name; any process that knows it can use the session. */
  key: string;
  origin: Exclude<SessionOrigin, 'this-server'>;
  coordinateSpace?: { width: number; height: number };
  deviceOrientation?: string;
  snapshot?: { id: number; key: string; bundleId?: string; elements: ScreenElement[] };
  queue: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  closing: boolean;
  pending: number;
  activity: DeviceActivity[];
}

const orientationNames = { portrait: 'portrait', landscapeLeft: 'landscape left', landscapeRight: 'landscape right', portraitUpsideDown: 'upside down' } as const;
const buttonNames = { home: 'Home', lock: 'Lock', volumeUp: 'Volume Up', volumeDown: 'Volume Down' } as const;

/** "points" sizes images to logical points for agents; "full" keeps device pixels for the viewer. */
export type Resolution = 'points' | 'full';
export interface CaptureOptions {
  resolution?: Resolution;
  /** Defaults to "always"; agents pass "auto" to rely on the element list. */
  screenshot?: ScreenshotMode;
  accessibilityEnabled?: boolean;
  /** Computer-use observations can request AX without changing the viewer preference. */
  updateAccessibilityPreference?: boolean;
  simulatorOnly?: boolean;
}
export interface ActionOptions extends CaptureOptions {
  settle?: boolean;
  /** Reject an element reference from an earlier observation before sending input. */
  snapshot?: number;
}

export interface AppleHubOptions {
  boundary?: AppleBoundary;
  idleTimeoutMs?: number;
  /** How long a request may wait on a device before it returns an error. */
  operationDeadlineMs?: number;
  video?: SimulatorVideo;
  registry?: SessionRegistry;
}

export interface ConnectOptions {
  /** Join a session another tool holds on the device. */
  takeOver?: boolean;
}

export interface CreateSimulatorOptions {
  deviceType?: string;
  runtime?: string;
  name?: string;
  /** Copy a shut-down simulator, including its apps and data. */
  cloneFrom?: string;
}

export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED';
  constructor() {
    super('Device session expired or disconnected. Connect to the device again.');
    this.name = 'SessionExpiredError';
  }
}

export class AppleHub {
  private readonly boundary: AppleBoundary;
  private readonly idleTimeoutMs: number;
  private readonly operationDeadlineMs: number;
  private readonly sessions = new Map<string, NativeSession>();
  private readonly connecting = new Map<string, Promise<ConnectedSession>>();
  private readonly registry: SessionRegistry;
  /** The registry's focus, re-read at most once a second because video reads ask for it at frame rate. */
  private focusCache?: { value?: DeviceFocus; readAt: number; reading?: Promise<void> };
  private closed = false;
  private closing?: Promise<void>;
  private snapshots = 0;
  private activityIds = 0;
  /** The last activity each video stream has delivered to its viewer. */
  private readonly activityCursors = new Map<string, { sessionId: string; delivered: number }>();
  private readonly video: SimulatorVideo;

  constructor(options: AppleHubOptions = {}) {
    this.boundary = options.boundary ?? new NativeAppleBoundary();
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.operationDeadlineMs = options.operationDeadlineMs ?? OPERATION_DEADLINE_MS;
    this.registry = options.registry ?? new SessionRegistry();
    this.video = options.video ?? new SimulatorVideo({
      helper: new URL(import.meta.url.endsWith('/src/apple.ts') ? '../plugins/apple-device-hub/dist/simulator-stream' : './simulator-stream', import.meta.url),
      keepAlive: id => this.keepVideoSessionAlive(id),
    });
  }

  videoOrigin(): Promise<string> { return this.video.origin(); }

  private videoSession(sessionId: string): NativeSession {
    const session = this.sessions.get(sessionId);
    if (this.closed || !session || session.closing) throw new SessionExpiredError();
    if (session.public.device.kind !== 'simulator') throw new Error('Video streaming currently supports Apple simulators. Physical devices use captured screens.');
    return session;
  }

  async stream(sessionId: string, format: "hevc" | "h264" = "h264", maxDimension?: number): Promise<VideoStream> {
    const session = this.videoSession(sessionId);
    const stream = await this.video.stream(sessionId, session.public.device.id, format, maxDimension);
    if (session.closing || this.closed) {
      this.video.closeSession(sessionId);
      throw new SessionExpiredError();
    }
    if (stream.streamId) this.activityCursors.set(stream.streamId, { sessionId, delivered: this.activityIds });
    this.keepVideoSessionAlive(sessionId);
    return stream;
  }

  /** Video reads stay outside the device queue so input never pauses the live stream. They also carry new device activity. */
  async streamRead(sessionId: string, streamId: string): Promise<VideoBatch> {
    const session = this.videoSession(sessionId);
    clearTimeout(session.timer);
    session.pending++;
    try {
      const batch = await this.video.read(sessionId, streamId);
      this.videoSession(sessionId);
      const cursor = this.activityCursors.get(streamId);
      const activity = cursor ? session.activity.filter(item => item.id > cursor.delivered) : [];
      if (activity.length) cursor!.delivered = activity.at(-1)!.id;
      const focus = this.otherFocus(session);
      if (!activity.length && !focus) return batch;
      return { ...batch, ...(activity.length ? { activity } : {}), ...(focus ? { focus } : {}) };
    } catch (error) {
      // Closing a device also closes its pending relay read. Preserve the
      // session-expired result so the viewer can clear the disconnected screen.
      this.videoSession(sessionId);
      throw error;
    } finally {
      session.pending--;
      this.keepVideoSessionAlive(sessionId);
    }
  }

  async streamStop(sessionId: string, streamId: string): Promise<void> {
    this.videoSession(sessionId);
    this.video.stop(sessionId, streamId);
    if (this.activityCursors.get(streamId)?.sessionId === sessionId) this.activityCursors.delete(streamId);
  }

  private recordActivity(session: NativeSession, activity: Omit<DeviceActivity, 'id' | 'at'>) {
    session.activity.push({ id: ++this.activityIds, at: new Date().toISOString(), ...activity });
    if (session.activity.length > 20) session.activity.shift();
  }

  /** Live viewer input bypasses the serial device queue, so it never waits behind an observation. */
  async input(sessionId: string, events: LiveInput[]): Promise<void> {
    this.videoSession(sessionId);
    this.video.input(sessionId, events);
  }

  private keepVideoSessionAlive(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing || session.pending) return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => { void this.disconnect(sessionId).catch(() => {}); }, this.idleTimeoutMs);
    session.timer.unref();
  }

  private publicSession(session: NativeSession): Session {
    return { ...session.public, device: { ...session.public.device } };
  }

  private async deviceJson(args: string[], timeoutMs?: number): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'apple-device-info-'));
    try {
      const output = join(directory, 'result.json');
      await this.boundary.command(['devicectl', '--quiet', ...args, '--json-output', output], timeoutMs);
      return await readFile(output, 'utf8');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async deviceList(): Promise<{ devices: Device[]; warnings: string[] }> {
    const [simulators, physical, created] = await Promise.allSettled([
      this.boundary.command(['simctl', 'list', 'devices', '-j']).then(simulatorDevices),
      this.deviceJson(['list', 'devices']).then(physicalDevices),
      this.registry.createdDevices(),
    ]);
    const devices: Device[] = [];
    const warnings: string[] = [];
    [simulators, physical].forEach((result, index) => {
      if (result.status === 'fulfilled') devices.push(...result.value);
      else warnings.push(`${index === 0 ? 'Simulator' : 'Physical device'} discovery failed: ${String(result.reason)}`);
    });
    const ours = new Set(created.status === 'fulfilled' ? created.value : []);
    return { devices: devices.map(device => ours.has(device.id) ? { ...device, createdByHub: true } : device), warnings };
  }

  async status(): Promise<HubState> {
    const [discovered, elsewhere, focus] = await Promise.all([
      this.deviceList(),
      this.registry.elsewhere().catch(() => []),
      this.registry.focus().catch(() => undefined),
    ]);
    return {
      ...discovered,
      sessions: [...this.sessions.values()].filter((session) => !session.closing).map((session) => this.publicSession(session)),
      elsewhere: elsewhere.map(session => ({ deviceId: session.deviceId, deviceName: session.deviceName, holders: session.holders.length, ...(session.foreign ? { otherTool: true } : {}) })),
      ...(focus ? { focus: { deviceId: focus.deviceId, deviceName: focus.deviceName, at: focus.at } } : {}),
    };
  }

  /**
   * Opens a session, reusing this server's session for the device or joining
   * the one another Device Hub server holds. Viewers follow the connected device.
   */
  async connect(deviceId: string, options: ConnectOptions = {}): Promise<ConnectedSession> {
    if (this.closed) throw new Error('Apple Device Hub is closed.');
    const existing = [...this.sessions.values()].find((session) => session.public.device.id === deviceId && !session.closing);
    if (existing) {
      await this.focusOn(existing.public.device);
      return { ...this.publicSession(existing), origin: 'this-server' };
    }
    const pending = this.connecting.get(deviceId);
    if (pending) return pending;
    const connection = this.startSession(deviceId, options);
    this.connecting.set(deviceId, connection);
    try { return await connection; }
    finally { this.connecting.delete(deviceId); }
  }

  private async startSession(deviceId: string, { takeOver = false }: ConnectOptions, retried = false): Promise<ConnectedSession> {
    const { devices, warnings } = await this.deviceList();
    if (this.closed) throw new Error('Apple Device Hub is closed.');
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error(`Device is not in the local device list. ${warnings.join(' ')}`.trim());
    if (!device.available) throw new Error(`${device.name} is unavailable. Connect and pair the device, or install its simulator runtime.`);
    const sessionId = randomUUID();
    let key: string;
    let origin: NativeSession['origin'] = 'new';
    try {
      const data = appleToolData(await this.boundary.tool('DeviceInteractionStartSession', {
        deviceIdentifier: device.id, sessionIdentifier: `${SESSION_LABEL} ${randomBytes(4).toString('hex').toUpperCase()}`,
      }));
      if (!data.interactionSessionKey) throw new Error('Xcode returned no device interaction session key.');
      key = data.interactionSessionKey;
    } catch (error) {
      // Xcode allows one session per device and names the session holding it.
      const holder = error instanceof Error ? error.message.match(/in use by a different session with key '([^']+)'/)?.[1] : undefined;
      if (!holder) throw error;
      const shared = await this.registry.find(holder).catch(() => undefined);
      origin = shared ? (shared.foreign ? 'other-tool' : 'device-hub') : holder.startsWith(SESSION_LABEL) ? 'device-hub' : 'other-tool';
      if (origin === 'other-tool' && !shared && !takeOver) {
        throw new Error(`${device.name} is in use by another tool's Xcode session, “${holder}”. Ask the user before taking it over: device_connect with takeOver: true joins that session so both can drive the device. Device Hub never ends a session it did not start.`);
      }
      key = holder;
    }
    const session: NativeSession = {
      public: { id: sessionId, device: { ...device, state: device.kind === 'simulator' ? 'Booted' : device.state }, accessibilityEnabled: true },
      key, origin, queue: Promise.resolve(), closing: false, pending: 0, activity: [],
    };
    this.sessions.set(session.public.id, session);
    try {
      await this.registry.hold({ key, deviceId: device.id, deviceName: device.name, ...(origin === 'other-tool' ? { foreign: true } : {}) }, sessionId);
      // The initial native observation establishes logical coordinates even
      // when the user subsequently hides the accessibility tree.
      await this.serial(session.public.id, () => this.nativeCapture(session, {}, BOOT_TIMEOUT_MS), BOOT_TIMEOUT_MS + 10_000);
      if (this.closed || session.closing) throw new SessionExpiredError();
      await this.focusOn(device);
      return { ...this.publicSession(session), origin };
    } catch (error) {
      await this.disconnect(session.public.id).catch(() => {});
      // A joined session can end between Xcode naming it and the first observation.
      if (error instanceof SessionExpiredError && origin !== 'new' && !retried && !this.closed) return this.startSession(deviceId, { takeOver }, true);
      throw error;
    }
  }

  private async focusOn(device: Device) {
    this.focusCache = { value: { deviceId: device.id, deviceName: device.name, at: new Date().toISOString() }, readAt: Date.now() };
    await this.registry.setFocus(device.id, device.name).catch(() => {});
  }

  /** The device the agent connected most recently, when it is not this session's. */
  private otherFocus(session: NativeSession): DeviceFocus | undefined {
    const cache = this.focusCache ??= { readAt: 0 };
    if (Date.now() - cache.readAt > 1000 && !cache.reading) {
      cache.reading = this.registry.focus().then(focus => {
        cache.value = focus && { deviceId: focus.deviceId, deviceName: focus.deviceName, at: focus.at };
      }, () => {}).finally(() => { cache.readAt = Date.now(); cache.reading = undefined; });
    }
    return cache.value && cache.value.deviceId !== session.public.device.id ? cache.value : undefined;
  }

  /** Xcode ended the session, through another tool or a restart, so there is nothing left to end. */
  private expire(session: NativeSession) {
    if (session.closing) return;
    session.closing = true;
    clearTimeout(session.timer);
    this.video.closeSession(session.public.id);
    for (const [streamId, cursor] of this.activityCursors) if (cursor.sessionId === session.public.id) this.activityCursors.delete(streamId);
    this.sessions.delete(session.public.id);
    void this.registry.release(session.key, session.public.id).catch(() => {});
  }

  /** Creates a simulator, or clones a shut-down one, and remembers it so deleteSimulator may remove it. */
  async createSimulator(options: CreateSimulatorOptions): Promise<Device> {
    if (this.closed) throw new Error('Apple Device Hub is closed.');
    let id: string;
    if (options.cloneFrom) {
      const source = (await this.deviceList()).devices.find(device => device.id === options.cloneFrom && device.kind === 'simulator');
      if (!source) throw new Error('cloneFrom must be a simulator ID from device_hub_status.');
      if (source.state !== 'Shutdown') {
        throw new Error(`${source.name} is ${source.state.toLowerCase()}, and Xcode clones only shut-down simulators. Create a fresh simulator with deviceType instead, or ask the user before shutting it down.`);
      }
      id = (await this.boundary.command(['simctl', 'clone', source.id, options.name ?? `${source.name} (Device Hub)`], 120_000)).trim();
    } else {
      if (!options.deviceType) throw new Error('Choose a deviceType, such as "iPhone 17 Pro", or a simulator to clone.');
      const { deviceType, runtime } = resolveSimulatorType(await this.boundary.command(['simctl', 'list', 'runtimes', '-j']), options.deviceType, options.runtime);
      id = (await this.boundary.command(['simctl', 'create', options.name ?? `${deviceType.name} (Device Hub)`, deviceType.identifier, runtime.identifier])).trim();
    }
    if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(id)) throw new Error(`Xcode did not return a new simulator ID. ${id}`.trim());
    await this.registry.markCreated(id);
    const device = (await this.deviceList()).devices.find(candidate => candidate.id === id);
    if (!device) throw new Error('The new simulator did not appear in the device list.');
    return device;
  }

  /**
   * Deletes a simulator this hub created; any other simulator belongs to the
   * user. Its session ends for every holder, so a viewer in another chat or
   * window that followed it reports the session ended on its next request.
   */
  async deleteSimulator(deviceId: string): Promise<Device> {
    const device = (await this.deviceList()).devices.find(candidate => candidate.id === deviceId && candidate.kind === 'simulator');
    if (!device) throw new Error('That simulator is not in the device list.');
    if (!device.createdByHub) throw new Error(`${device.name} was not created by Device Hub, so Device Hub will not delete it.`);
    const local = [...this.sessions.values()].filter(session => session.public.device.id === deviceId);
    const shared = await this.registry.forDevice(deviceId).catch(() => []);
    for (const key of new Set([...local.map(session => session.key), ...shared.map(session => session.key)])) {
      await this.boundary.tool('DeviceInteractionEndSession', { interactionSessionKey: key }).catch(() => {});
      await this.registry.drop(key).catch(() => {});
    }
    for (const session of local) this.expire(session);
    if (device.state !== 'Shutdown') await this.boundary.command(['simctl', 'shutdown', deviceId], 60_000).catch(() => {});
    await this.boundary.command(['simctl', 'delete', deviceId], 60_000);
    await this.registry.forgetCreated(deviceId);
    await this.registry.clearFocus(deviceId);
    if (this.focusCache?.value?.deviceId === deviceId) this.focusCache = undefined;
    return device;
  }

  private async serial<T>(sessionId: string, operation: (session: NativeSession) => Promise<T>, deadlineMs = this.operationDeadlineMs): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (this.closed || !session || session.closing) throw new SessionExpiredError();
    clearTimeout(session.timer);
    session.pending++;
    let started = false, abandoned = false;
    const result = session.queue.then(() => {
      // A caller that already gave up must not have its input delivered late.
      if (abandoned) throw new Error('Abandoned device request.');
      started = true;
      return operation(session);
    });
    session.queue = result.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        reject(new Error(started
          ? `The device did not finish within ${deadlineMs / 1000} s. It may still complete; observe the screen before retrying.`
          : 'The device is still busy with an earlier request. Try again shortly.'));
      }, deadlineMs);
    });
    try { return await Promise.race([result, deadline]); }
    finally {
      clearTimeout(timer);
      session.pending--;
      if (!session.closing && session.pending === 0) {
        session.timer = setTimeout(() => { void this.disconnect(sessionId).catch(() => {}); }, this.idleTimeoutMs);
        session.timer.unref?.();
      }
    }
  }

  private requireSimulator(session: NativeSession, options: CaptureOptions) {
    if (options.simulatorOnly && session.public.device.kind !== 'simulator') {
      throw new Error('Simulator computer-use tools require a simulator session. Connect to a running simulator first.');
    }
  }

  async capture(sessionId: string, options: CaptureOptions = {}): Promise<Capture> {
    return this.serial(sessionId, async (session) => {
      this.requireSimulator(session, options);
      const enabled = options.accessibilityEnabled ?? session.public.accessibilityEnabled;
      const capture = enabled ? await this.nativeCapture(session) : await this.screenCapture(session);
      if (options.updateAccessibilityPreference ?? true) session.public.accessibilityEnabled = enabled;
      return this.captureResult(session, capture, enabled, options);
    });
  }

  /** Re-encodes an observation at logical-point size so image pixels equal tap coordinates. */
  private async pointImage(session: NativeSession, image: Buffer): Promise<Buffer> {
    const viewport = session.coordinateSpace;
    if (!this.boundary.compress || !viewport) return image;
    const directory = await mkdtemp(join(tmpdir(), 'apple-device-points-'));
    try {
      const source = join(directory, 'source.png');
      const output = join(directory, 'points.jpg');
      await writeFile(source, image);
      await this.boundary.compress(source, output, Math.round(Math.max(viewport.width, viewport.height)));
      return await readFile(output);
    } catch {
      return image;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async captureResult(session: NativeSession, observation: NativeObservation, accessibilityEnabled: boolean, { resolution = 'points', screenshot = 'always' }: CaptureOptions = {}): Promise<Capture> {
    if (!session.coordinateSpace) throw new Error('Device logical coordinates are unavailable. Capture the accessibility hierarchy again.');
    const elements = accessibilityEnabled ? session.snapshot?.elements : undefined;
    // A screen with almost no elements (games, canvases, web content, boot) needs the image to be understood.
    const includeImage = screenshot === 'always' || (screenshot === 'auto' && (elements?.length ?? 0) < 3);
    let settings: DeviceSettings | undefined;
    try {
      settings = appearanceSettings(await this.deviceJson(['--timeout', '5', 'device', 'info', 'appearance', '--device', session.public.device.id], 7_000));
    } catch {
      // Older device runtimes do not expose all appearance options. Omitting
      // settings keeps their controls unknown rather than claiming defaults.
    }
    return {
      session: this.publicSession(session), capturedAt: new Date().toISOString(),
      ...(includeImage ? { screenshot: await (async () => {
        const image = resolution === 'points' ? await this.pointImage(session, observation.image) : observation.image;
        return { ...imageInfo(image), data: image.toString('base64') };
      })() } : {}),
      coordinateSpace: { ...session.coordinateSpace },
      ...(session.deviceOrientation ? { deviceOrientation: session.deviceOrientation } : {}),
      ...(accessibilityEnabled ? { hierarchy: observation.hierarchy } : {}),
      ...(observation.applicationState ? { applicationState: observation.applicationState } : {}),
      ...(settings ? { settings } : {}),
      ...(session.snapshot ? { snapshot: session.snapshot.id, ...(session.snapshot.bundleId ? { bundleId: session.snapshot.bundleId } : {}) } : {}),
      ...(elements ? { elements } : {}),
    };
  }

  private async nativeCapture(session: NativeSession, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<NativeObservation> {
    let failure = new Error('Xcode accessibility hierarchy is temporarily unavailable; the device may still be starting. Observe again in a few seconds.');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 300));
      let data: ObjectValue;
      try {
        data = appleToolData(await this.boundary.tool('DeviceInteractionSynthesize', {
          interactSessionKey: session.key, interactionCommand: '', ...(attempt === 0 ? args : {}),
        }, timeoutMs));
      } catch (error) {
        if (error instanceof Error && /Session not found/i.test(error.message)) {
          this.expire(session);
          throw new SessionExpiredError();
        }
        throw error;
      }
      if (!data.hierarchyPath) continue;
      const hierarchy = await readFile(data.hierarchyPath, 'utf8');
      const image = await readFile(data.screenshotPath);
      const size = pngDimensions(image);
      try { session.coordinateSpace = logicalDimensions(hierarchy, size); }
      catch (error) {
        // While a device starts, Xcode can report a hierarchy with no window.
        // The previous bounds hold while the screen keeps its shape; a window
        // of another shape is a rotation and must not reuse them.
        const previous = session.coordinateSpace;
        const windowless = !/^\s*(?:UIWindow|Window)\b/m.test(hierarchy);
        if (!windowless || !previous || Math.abs(previous.width / previous.height - size.width / size.height) >= 0.02) {
          failure = error as Error;
          continue;
        }
      }
      session.deviceOrientation = hierarchy.match(/^Device orientation: (.+)$/m)?.[1];
      this.recordSnapshot(session, hierarchy);
      return { image, hierarchy, applicationState: data.applicationState };
    }
    throw failure;
  }

  private recordSnapshot(session: NativeSession, hierarchy: string) {
    const { bundleId, elements } = summarizeHierarchy(hierarchy, session.coordinateSpace!);
    const key = JSON.stringify([bundleId, session.coordinateSpace, session.deviceOrientation, elements]);
    if (session.snapshot?.key === key) return;
    session.snapshot = { id: ++this.snapshots, key, bundleId, elements };
  }

  private element(session: NativeSession, target: ElementTarget): ScreenElement {
    if (!session.snapshot) throw new Error('No accessibility snapshot yet. Capture the device first.');
    return resolveElement(session.snapshot.elements, target);
  }

  /** A fast screenshot used for live frames and idle detection. Simulators return JPEG, devices PNG. */
  private async quickScreenshot(session: NativeSession, directory: string): Promise<{ path: string; image: Buffer }> {
    const simulator = session.public.device.kind === 'simulator';
    const path = join(directory, `screen-${randomUUID()}.${simulator ? 'jpg' : 'png'}`);
    await this.boundary.command(simulator
      ? ['simctl', 'io', session.public.device.id, 'screenshot', '--type=jpeg', path]
      : ['devicectl', '--quiet', 'device', 'capture', 'screenshot', '--device', session.public.device.id, '--destination', path]);
    return { path, image: await readFile(path) };
  }

  /** Waits until two consecutive screenshots match, so results show the screen after animations. */
  private async waitForIdle(session: NativeSession, budgetMs = 2500): Promise<boolean> {
    const directory = await mkdtemp(join(tmpdir(), 'apple-device-idle-'));
    try {
      const deadline = Date.now() + budgetMs;
      let previous: Buffer | undefined;
      while (Date.now() < deadline) {
        const { image } = await this.quickScreenshot(session, directory);
        if (previous?.equals(image)) return true;
        previous = image;
      }
      return false;
    } catch {
      return false;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async screenCapture(session: NativeSession): Promise<NativeObservation> {
    const directory = await mkdtemp(join(tmpdir(), 'apple-device-capture-'));
    try {
      const destination = join(directory, 'screenshot.png');
      await this.boundary.command(session.public.device.kind === 'simulator'
        ? ['simctl', 'io', session.public.device.id, 'screenshot', '--type=png', destination]
        : ['devicectl', '--quiet', 'device', 'capture', 'screenshot', '--device', session.public.device.id, '--destination', destination]);
      const image = await readFile(destination);
      const size = pngDimensions(image);
      const viewport = session.coordinateSpace;
      // A rotation outside this panel invalidates cached touch coordinates.
      // Refresh from the native window rather than guessing a pixel scale.
      if (!viewport || Math.abs(size.width / size.height - viewport.width / viewport.height) > 0.02) {
        return this.nativeCapture(session);
      }
      return { image };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * A lightweight screen-only frame for the live viewer: a downscaled JPEG with
   * no hierarchy or settings query, so frames arrive at a steady cadence.
   */
  async frame(sessionId: string): Promise<Capture> {
    return this.serial(sessionId, async (session) => {
      const directory = await mkdtemp(join(tmpdir(), 'apple-device-frame-'));
      try {
        const { path: source, image: captured } = await this.quickScreenshot(session, directory);
        let image = captured;
        if (this.boundary.compress) {
          const compressed = join(directory, 'frame.jpg');
          try { await this.boundary.compress(source, compressed, 1400); image = await readFile(compressed); }
          catch { /* Send the full-size capture rather than dropping the frame. */ }
        }
        const info = imageInfo(image);
        const viewport = session.coordinateSpace;
        // A rotation invalidates cached touch coordinates; take a full observation instead.
        if (!viewport || Math.abs(info.width / info.height - viewport.width / viewport.height) > 0.02) {
          const enabled = session.public.accessibilityEnabled;
          return this.captureResult(session, await this.nativeCapture(session), enabled, { resolution: 'full' });
        }
        const focus = this.otherFocus(session);
        return {
          session: this.publicSession(session), capturedAt: new Date().toISOString(),
          screenshot: { ...info, data: image.toString('base64') },
          coordinateSpace: { ...viewport },
          ...(session.deviceOrientation ? { deviceOrientation: session.deviceOrientation } : {}),
          ...(focus ? { focus } : {}),
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  async action(sessionId: string, rawAction: DeviceAction, options: ActionOptions = {}): Promise<Capture> {
    const action = actionSchema.parse(rawAction);
    return this.serial(sessionId, async (session) => {
      this.requireSimulator(session, options);
      if (options.snapshot !== undefined) {
        // The user or app can navigate without passing through this hub.
        // Re-observe inside the same queue operation before trusting old refs.
        await this.nativeCapture(session);
        if (options.snapshot !== session.snapshot?.id) {
          throw new Error('Accessibility snapshot is stale. Get the simulator state again before using an element reference.');
        }
      }
      const bounds = () => {
        if (!session.coordinateSpace) throw new Error('Device logical coordinates are unavailable. Capture again.');
        return session.coordinateSpace;
      };
      const point = (x: number, y: number) => {
        const { width, height } = bounds();
        const roundedX = round(x), roundedY = round(y);
        if (roundedX < 0 || roundedY < 0 || roundedX >= width || roundedY >= height) throw new Error('Touch coordinates are outside the latest device window. Capture again.');
        return `${roundedX} ${roundedY}`;
      };
      const synthesize = async (interactionCommand: string, activationBundleId?: string) => {
        try {
          return await this.nativeCapture(session, { interactionCommand, ...(activationBundleId ? { activationBundleId } : {}) });
        } catch (error) {
          // Input may have been delivered even if observation failed. Old refs
          // cannot safely describe the screen after that unknown result.
          session.snapshot = undefined;
          throw error;
        }
      };
      // Viewers show each action on the live screen; typed text is not repeated there.
      const note = (summary: string, element?: ScreenElement, at?: { x: number; y: number }, to?: { x: number; y: number }) => this.recordActivity(session, {
        summary: element ? `${summary} ${element.label ? `“${element.label}”` : element.role}` : summary,
        ...(element ? { ref: element.ref } : {}), ...(at ? { point: at } : {}), ...(to ? { to } : {}),
      });
      let observation: NativeObservation;
      switch (action.type) {
        case 'tap': {
          const element = action.element ? this.element(session, action.element) : undefined;
          const target = element?.point ?? (action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined);
          if (!target) throw new Error('Tap needs an element target or both x and y.');
          const command = `${action.clickCount === 2 ? 'd' : 't'} ${point(target.x, target.y)}${action.duration !== undefined ? ` ${action.duration}` : ''}`;
          note(action.clickCount === 2 ? 'Double-tap' : action.duration !== undefined ? 'Long press' : 'Tap', element, target);
          observation = await synthesize(command);
          break;
        }
        case 'swipe': {
          const command = `t ${point(action.x, action.y)} f ${point(action.toX, action.toY)} ${action.duration}`;
          note('Swipe', undefined, { x: action.x, y: action.y }, { x: action.toX, y: action.toY });
          observation = await synthesize(command);
          break;
        }
        case 'scroll': {
          const element = action.element ? this.element(session, action.element) : undefined;
          const { from, to } = action.x !== undefined
            ? scrollFromPoint({ x: action.x, y: action.y! }, bounds(), action.direction, action.distance)
            : scrollGesture(scrollRegion(element?.frame, bounds()), action.direction, action.distance);
          const command = `t ${point(from.x, from.y)} f ${point(to.x, to.y)} 0.5`;
          note(`Scroll ${action.direction}`, element, from, to);
          observation = await synthesize(command);
          break;
        }
        case 'type':
          if (action.element || action.x !== undefined) {
            const element = action.element ? this.element(session, action.element) : undefined;
            const target = element?.point ?? { x: action.x!, y: action.y! };
            const command = `t ${point(target.x, target.y)}`;
            note(element ? 'Type into' : 'Type text', element, target);
            await synthesize(command);
          } else note('Type text');
          observation = await synthesize(keyboardCommand(action.text));
          break;
        case 'pressKey': {
          const commands = {
            Return: keyboardCommand('\n'), Tab: keyboardCommand('\t'), Backspace: keyboardCommand('\b'),
            Home: 'b h', Lock: 'b p', VolumeUp: 'b u', VolumeDown: 'b d',
          };
          note(`Press ${action.key}`);
          observation = await synthesize(commands[action.key]);
          break;
        }
        case 'button': {
          const buttons = { home: 'h', lock: 'p', volumeUp: 'u', volumeDown: 'd' };
          note(`Press ${buttonNames[action.button]}`);
          observation = await synthesize(`b ${buttons[action.button]}`);
          break;
        }
        case 'orientation': note(`Rotate to ${orientationNames[action.orientation]}`); observation = await synthesize(`orientation ${action.orientation}`); break;
        case 'openSettings': note('Open Settings'); observation = await synthesize('', 'com.apple.Preferences'); break;
        case 'launchApp': note(`Open ${action.bundleId}`); observation = await synthesize('', action.bundleId); break;
      }
      // Xcode observes immediately after the event, often mid-transition. Observe again once the screen is still.
      if (options.settle ?? true) {
        await this.waitForIdle(session);
        observation = await synthesize('');
      }
      return this.captureResult(session, observation, options.accessibilityEnabled ?? session.public.accessibilityEnabled, options);
    });
  }


  async settings(sessionId: string, rawSettings: DeviceSettings, options: CaptureOptions = {}): Promise<Capture> {
    const settings = settingsSchema.parse(rawSettings);
    return this.serial(sessionId, async (session) => {
      this.requireSimulator(session, options);
      // Appearance and text size can move controls even when AX is hidden.
      // A screenshot-only result cannot verify the old element positions.
      if (Object.keys(settings).length) session.snapshot = undefined;
      const id = session.public.device.id;
      if (session.public.device.kind === 'simulator') {
        if (settings.appearance) await this.boundary.command(['simctl', 'ui', id, 'appearance', settings.appearance]);
        if (settings.textSize) await this.boundary.command(['simctl', 'ui', id, 'content_size', settings.textSize]);
        if (settings.increasedContrast !== undefined) await this.boundary.command(['simctl', 'ui', id, 'increase_contrast', settings.increasedContrast ? 'enabled' : 'disabled']);
      }
      const flags: string[] = [];
      if (session.public.device.kind === 'device') {
        if (settings.appearance) flags.push('--mode', settings.appearance);
        if (settings.textSize) {
          flags.push('--larger-accessibility-sizes', settings.textSize.startsWith('accessibility-') ? 'on' : 'off');
          flags.push('--text-size', settings.textSize);
        }
        if (settings.increasedContrast !== undefined) flags.push('--increase-contrast', settings.increasedContrast ? 'on' : 'off');
      }
      if (settings.reduceMotion !== undefined) flags.push('--reduce-motion', settings.reduceMotion ? 'on' : 'off');
      if (settings.reduceTransparency !== undefined) flags.push('--reduce-transparency', settings.reduceTransparency ? 'on' : 'off');
      if (flags.length) await this.boundary.command(['devicectl', '--quiet', 'device', 'settings', 'appearance', '--device', id, ...flags]);
      const enabled = options.accessibilityEnabled ?? session.public.accessibilityEnabled;
      const capture = enabled ? await this.nativeCapture(session) : await this.screenCapture(session);
      return this.captureResult(session, capture, enabled, options);
    });
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.closing) { await session.queue; return; }
    session.closing = true;
    clearTimeout(session.timer);
    this.video.closeSession(sessionId);
    for (const [streamId, cursor] of this.activityCursors) if (cursor.sessionId === sessionId) this.activityCursors.delete(streamId);
    const ending = session.queue.then(async () => {
      try {
        // Another chat or window may still share the session; the last Device Hub holder ends it.
        const { last, foreign } = await this.registry.release(session.key, sessionId)
          .catch(() => ({ last: session.origin === 'new', foreign: session.origin === 'other-tool' }));
        if (last && !foreign) appleToolData(await this.boundary.tool('DeviceInteractionEndSession', { interactionSessionKey: session.key }));
      } finally { this.sessions.delete(sessionId); }
    });
    session.queue = ending.catch(() => {});
    await ending;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.video.close();
      await Promise.allSettled([...this.connecting.values()]);
      const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.disconnect(id)));
      await this.boundary.close();
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.closing;
  }
}

interface NativeObservation {
  image: Buffer;
  hierarchy?: string;
  applicationState?: string;
}
