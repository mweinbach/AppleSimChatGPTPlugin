import { execFile } from 'node:child_process';
import { version } from './version.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveElement, summarizeHierarchy, type Rect, type ScreenElement } from './elements.js';
import { actionSchema, settingsSchema, textSizeSchema, type Capture, type Device, type DeviceAction, type DeviceSettings, type ElementTarget, type HubState, type LiveInput, type Session } from './shared.js';
import { SimulatorVideo, type VideoBatch, type VideoStream } from './video.js';

export interface AppleBoundary {
  command(args: string[], timeoutMs?: number): Promise<string>;
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
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
          await client.connect(transport);
          return client;
        } catch (error) {
          await transport.close();
          throw new Error(`Could not connect to Xcode MCP. Enable Xcode Settings > Intelligence > Model Context Protocol, then retry. ${this.stderr || String(error)}`);
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

  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return (await this.connect()).callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  }

  async close(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    if (pending) await (await pending).close();
  }
}

type ObjectValue = Record<string, any>;

/** Apple returns structuredContent; text JSON also supports its older bridge releases. */
export function appleToolData(result: unknown): ObjectValue {
  const response = result as ObjectValue;
  const text = (response.content ?? []).filter((item: ObjectValue) => item.type === 'text').map((item: ObjectValue) => item.text).join('\n');
  if (response.isError) throw new Error(text || 'Xcode device interaction failed.');
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
  key: string;
  coordinateSpace?: { width: number; height: number };
  deviceOrientation?: string;
  snapshot?: { id: number; key: string; bundleId?: string; elements: ScreenElement[] };
  queue: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  closing: boolean;
  pending: number;
}

/** "points" sizes images to logical points for agents; "full" keeps device pixels for the viewer. */
export type Resolution = 'points' | 'full';
export interface CaptureOptions {
  resolution?: Resolution;
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
  video?: SimulatorVideo;
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
  private readonly sessions = new Map<string, NativeSession>();
  private readonly connecting = new Map<string, Promise<Session>>();
  private closed = false;
  private closing?: Promise<void>;
  private snapshots = 0;
  private readonly video: SimulatorVideo;

  constructor(options: AppleHubOptions = {}) {
    this.boundary = options.boundary ?? new NativeAppleBoundary();
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
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
    this.keepVideoSessionAlive(sessionId);
    return stream;
  }

  /** Video reads stay outside the device queue so input never pauses the live stream. */
  async streamRead(sessionId: string, streamId: string): Promise<VideoBatch> {
    const session = this.videoSession(sessionId);
    clearTimeout(session.timer);
    session.pending++;
    try {
      const batch = await this.video.read(sessionId, streamId);
      this.videoSession(sessionId);
      return batch;
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
    const results = await Promise.allSettled([
      this.boundary.command(['simctl', 'list', 'devices', '-j']).then(simulatorDevices),
      this.deviceJson(['list', 'devices']).then(physicalDevices),
    ]);
    const devices: Device[] = [];
    const warnings: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') devices.push(...result.value);
      else warnings.push(`${index === 0 ? 'Simulator' : 'Physical device'} discovery failed: ${String(result.reason)}`);
    });
    return { devices, warnings };
  }

  async status(): Promise<HubState> {
    const discovered = await this.deviceList();
    return { ...discovered, sessions: [...this.sessions.values()].filter((session) => !session.closing).map((session) => this.publicSession(session)) };
  }

  async connect(deviceId: string): Promise<Session> {
    if (this.closed) throw new Error('Apple Device Hub is closed.');
    const existing = [...this.sessions.values()].find((session) => session.public.device.id === deviceId && !session.closing);
    if (existing) return this.publicSession(existing);
    const pending = this.connecting.get(deviceId);
    if (pending) return pending;
    const connection = this.startSession(deviceId);
    this.connecting.set(deviceId, connection);
    try { return await connection; }
    finally { this.connecting.delete(deviceId); }
  }

  private async startSession(deviceId: string): Promise<Session> {
    const { devices, warnings } = await this.deviceList();
    if (this.closed) throw new Error('Apple Device Hub is closed.');
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error(`Device is not in the local device list. ${warnings.join(' ')}`.trim());
    if (!device.available) throw new Error(`${device.name} is unavailable. Connect and pair the device, or install its simulator runtime.`);
    const sessionId = randomUUID();
    const data = appleToolData(await this.boundary.tool('DeviceInteractionStartSession', {
      deviceIdentifier: device.id, sessionIdentifier: `Apple Device Hub ${sessionId.slice(0, 8).toUpperCase()}`,
    }));
    if (!data.interactionSessionKey) throw new Error('Xcode returned no device interaction session key.');
    const session: NativeSession = {
      public: { id: sessionId, device: { ...device, state: device.kind === 'simulator' ? 'Booted' : device.state }, accessibilityEnabled: true },
      key: data.interactionSessionKey, queue: Promise.resolve(), closing: false, pending: 0,
    };
    this.sessions.set(session.public.id, session);
    try {
      // The initial native observation establishes logical coordinates even
      // when the user subsequently hides the accessibility tree.
      await this.capture(session.public.id);
      if (this.closed || session.closing) throw new SessionExpiredError();
      return this.publicSession(session);
    } catch (error) {
      await this.disconnect(session.public.id).catch(() => {});
      throw error;
    }
  }

  private async serial<T>(sessionId: string, operation: (session: NativeSession) => Promise<T>): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (this.closed || !session || session.closing) throw new SessionExpiredError();
    clearTimeout(session.timer);
    session.pending++;
    const result = session.queue.then(() => operation(session));
    session.queue = result.catch(() => {});
    try { return await result; }
    finally {
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
      return this.captureResult(session, capture, enabled, options.resolution);
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

  private async captureResult(session: NativeSession, observation: NativeObservation, accessibilityEnabled: boolean, resolution: Resolution = 'points'): Promise<Capture> {
    if (!session.coordinateSpace) throw new Error('Device logical coordinates are unavailable. Capture the accessibility hierarchy again.');
    let settings: DeviceSettings | undefined;
    try {
      settings = appearanceSettings(await this.deviceJson(['--timeout', '5', 'device', 'info', 'appearance', '--device', session.public.device.id], 7_000));
    } catch {
      // Older device runtimes do not expose all appearance options. Omitting
      // settings keeps their controls unknown rather than claiming defaults.
    }
    return {
      session: this.publicSession(session), capturedAt: new Date().toISOString(),
      screenshot: await (async () => {
        const image = resolution === 'points' ? await this.pointImage(session, observation.image) : observation.image;
        return { ...imageInfo(image), data: image.toString('base64') };
      })(),
      coordinateSpace: { ...session.coordinateSpace },
      ...(session.deviceOrientation ? { deviceOrientation: session.deviceOrientation } : {}),
      ...(accessibilityEnabled ? { hierarchy: observation.hierarchy } : {}),
      ...(observation.applicationState ? { applicationState: observation.applicationState } : {}),
      ...(settings ? { settings } : {}),
      ...(session.snapshot ? { snapshot: session.snapshot.id, ...(session.snapshot.bundleId ? { bundleId: session.snapshot.bundleId } : {}) } : {}),
      ...(accessibilityEnabled && session.snapshot ? { elements: session.snapshot.elements } : {}),
    };
  }

  private async nativeCapture(session: NativeSession, args: Record<string, unknown> = {}): Promise<NativeObservation> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const data = appleToolData(await this.boundary.tool('DeviceInteractionSynthesize', {
        interactSessionKey: session.key, interactionCommand: '', ...(attempt === 0 ? args : {}),
      }));
      if (!data.hierarchyPath) {
        if (attempt === 0) continue;
        throw new Error('Xcode accessibility hierarchy is temporarily unavailable. Capture again.');
      }
      const hierarchy = await readFile(data.hierarchyPath, 'utf8');
      const image = await readFile(data.screenshotPath);
      try { session.coordinateSpace = logicalDimensions(hierarchy, pngDimensions(image)); }
      catch (error) { if (attempt === 0) continue; throw error; }
      session.deviceOrientation = hierarchy.match(/^Device orientation: (.+)$/m)?.[1];
      this.recordSnapshot(session, hierarchy);
      return { image, hierarchy, applicationState: data.applicationState };
    }
    throw new Error('Could not capture device state.');
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
          return this.captureResult(session, await this.nativeCapture(session), enabled, 'full');
        }
        return {
          session: this.publicSession(session), capturedAt: new Date().toISOString(),
          screenshot: { ...info, data: image.toString('base64') },
          coordinateSpace: { ...viewport },
          ...(session.deviceOrientation ? { deviceOrientation: session.deviceOrientation } : {}),
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
      let observation: NativeObservation;
      switch (action.type) {
        case 'tap': {
          const target = action.element ? this.element(session, action.element).point : action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined;
          if (!target) throw new Error('Tap needs an element target or both x and y.');
          observation = await synthesize(`${action.clickCount === 2 ? 'd' : 't'} ${point(target.x, target.y)}${action.duration !== undefined ? ` ${action.duration}` : ''}`);
          break;
        }
        case 'swipe': observation = await synthesize(`t ${point(action.x, action.y)} f ${point(action.toX, action.toY)} ${action.duration}`); break;
        case 'scroll': {
          const { from, to } = action.x !== undefined
            ? scrollFromPoint({ x: action.x, y: action.y! }, bounds(), action.direction, action.distance)
            : scrollGesture(scrollRegion(action.element ? this.element(session, action.element).frame : undefined, bounds()), action.direction, action.distance);
          observation = await synthesize(`t ${point(from.x, from.y)} f ${point(to.x, to.y)} 0.5`);
          break;
        }
        case 'type':
          if (action.element || action.x !== undefined) {
            const target = action.element ? this.element(session, action.element).point : { x: action.x!, y: action.y! };
            await synthesize(`t ${point(target.x, target.y)}`);
          }
          observation = await synthesize(keyboardCommand(action.text));
          break;
        case 'pressKey': {
          const commands = {
            Return: keyboardCommand('\n'), Tab: keyboardCommand('\t'), Backspace: keyboardCommand('\b'),
            Home: 'b h', Lock: 'b p', VolumeUp: 'b u', VolumeDown: 'b d',
          };
          observation = await synthesize(commands[action.key]);
          break;
        }
        case 'button': {
          const buttons = { home: 'h', lock: 'p', volumeUp: 'u', volumeDown: 'd' };
          observation = await synthesize(`b ${buttons[action.button]}`);
          break;
        }
        case 'orientation': observation = await synthesize(`orientation ${action.orientation}`); break;
        case 'openSettings': observation = await synthesize('', 'com.apple.Preferences'); break;
        case 'launchApp': observation = await synthesize('', action.bundleId); break;
      }
      // Xcode observes immediately after the event, often mid-transition. Observe again once the screen is still.
      if (options.settle ?? true) {
        await this.waitForIdle(session);
        observation = await synthesize('');
      }
      return this.captureResult(session, observation, options.accessibilityEnabled ?? session.public.accessibilityEnabled, options.resolution);
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
      return this.captureResult(session, capture, enabled, options.resolution);
    });
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.closing) { await session.queue; return; }
    session.closing = true;
    clearTimeout(session.timer);
    this.video.closeSession(sessionId);
    const ending = session.queue.then(async () => {
      try { appleToolData(await this.boundary.tool('DeviceInteractionEndSession', { interactionSessionKey: session.key })); }
      finally { this.sessions.delete(sessionId); }
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
