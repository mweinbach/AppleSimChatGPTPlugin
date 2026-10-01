import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { AppleHub, SessionExpiredError, appleToolData, scrollFromPoint, scrollGesture, scrollRegion, appearanceSettings, imageInfo, jpegDimensions, keyboardCommand, logicalDimensions, physicalDevices, pngDimensions, simulatorDevices, type AppleBoundary } from '../src/apple.js';
import { actionSchema } from '../src/shared.js';
import { SimulatorVideo, type VideoBatch } from '../src/video.js';

const simulator = { udid: 'sim-1', name: 'iPhone', state: 'Shutdown', isAvailable: true };
const simulatorList = JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [simulator] } });
const physicalList = JSON.stringify({ result: { devices: [{
  identifier: 'core-id', properties: {
    hardware: { udid: 'physical-1', platform: 'iOS', reality: 'physical' },
    software: { osVersionNumber: { stringValue: '27.0' } },
    state: { name: 'My iPhone' }, connection: { state: 'disconnected', pairingState: 'paired' },
  },
}] } });
const portrait = 'Device orientation: Portrait\nApplication, pid: 123\n Window, {{0.0, 0.0}, {440.0, 956.0}}, hitPoint: {220.0, 478.0}\n  Other, {{0.0, 0.0}, {956.0, 440.0}}, hitPoint: {220.0, 478.0}';
const landscape = 'Device orientation: Landscape Left\n Window, {{0.0, 0.0}, {956.0, 440.0}}, hitPoint: {478, 220}';
const nativeAppearance = { result: {
  userInterfaceStyle: 'light', textSize: 'Large', increaseContrast: false,
  reduceMotion: { enabled: false }, reduceTransparency: { enabled: false },
} };

function png(width = 1320, height = 2868): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width = 644, height = 1400): Buffer {
  // SOI, an APP0 segment to skip, then a baseline SOF0 header.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(9, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

async function fixture(t: TestContext, idleTimeoutMs = 60_000, video?: SimulatorVideo, operationDeadlineMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'apple-hub-test-'));
  const screenshotPath = join(directory, 'native.png');
  const hierarchyPath = join(directory, 'native.txt');
  await writeFile(screenshotPath, png()); await writeFile(hierarchyPath, portrait);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const commands: string[][] = [];
  let toolHook: ((name: string, args: Record<string, unknown>) => Promise<unknown | undefined>) | undefined;
  let screen = png();
  let compressed: Buffer | undefined;
  let appearance: Object | undefined = nativeAppearance;
  let closed = false;
  const boundary: AppleBoundary = {
    async command(args) {
      commands.push(args);
      if (args[0] === 'simctl' && args[1] === 'list') return simulatorList;
      if (args[0] === 'devicectl' && args.includes('list')) {
        await writeFile(args[args.indexOf('--json-output') + 1]!, physicalList);
      }
      if (args[0] === 'devicectl' && args.includes('info') && args.includes('appearance')) {
        if (!appearance) throw new Error('Appearance queries unsupported.');
        await writeFile(args[args.indexOf('--json-output') + 1]!, JSON.stringify(appearance));
      }
      if (args.includes('screenshot')) {
        const destination = args.includes('--destination') ? args[args.indexOf('--destination') + 1]! : args.at(-1)!;
        await writeFile(destination, screen);
      }
      return '';
    },
    async tool(name, args) {
      calls.push({ name, args });
      const override = await toolHook?.(name, args);
      if (override !== undefined) return override;
      if (name === 'DeviceInteractionStartSession') return { structuredContent: { interactionSessionKey: 'secret-key', deviceUUID: 'sim-1', deviceIsSimulator: true } };
      if (name === 'DeviceInteractionSynthesize') return { structuredContent: { screenshotPath, hierarchyPath, applicationState: 'Running' } };
      return { structuredContent: { userMessage: 'Closed.' } };
    },
    async compress(_input, output) {
      if (!compressed) throw new Error('sips unavailable.');
      await writeFile(output, compressed);
    },
    async close() { closed = true; },
  };
  const hub = new AppleHub({ boundary, idleTimeoutMs, video, ...(operationDeadlineMs ? { operationDeadlineMs } : {}) });
  t.after(async () => {
    try { if (!closed) await hub.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { hub, boundary, calls, commands, screenshotPath, hierarchyPath,
    setToolHook(hook: typeof toolHook) { toolHook = hook; },
    setScreen(value: Buffer) { screen = value; },
    setAppearance(value: Object | undefined) { appearance = value; },
    setCompressed(value: Buffer | undefined) { compressed = value; },
    get closed() { return closed; },
  };
}

test('discovery parses current and legacy Apple JSON without duplicated simulated devices', () => {
  assert.deepEqual(simulatorDevices(simulatorList)[0], {
    id: 'sim-1', name: 'iPhone', kind: 'simulator', platform: 'iOS', runtime: 'iOS 27.2', state: 'Shutdown', available: true,
  });
  assert.deepEqual(physicalDevices(physicalList)[0], {
    id: 'physical-1', name: 'My iPhone', kind: 'device', platform: 'iOS', runtime: 'iOS 27.0', state: 'disconnected', available: true,
  });
  assert.equal(physicalDevices(JSON.stringify({ result: { devices: [{ hardwareProperties: { reality: 'simulated' } }] } })).length, 0);
  const legacy = { result: { devices: [{ identifier: 'legacy', hardwareProperties: { udid: 'legacy-udid', platform: 'watchOS' }, deviceProperties: { name: 'Watch', osVersionNumber: '27.0' }, connectionProperties: { tunnelState: 'unavailable', pairingState: 'paired' } }] } };
  assert.equal(physicalDevices(JSON.stringify(legacy))[0]?.available, false);
});

test('logical bounds use the root window and reject screenshot orientation mismatches', () => {
  assert.deepEqual(logicalDimensions(portrait, pngDimensions(png())), { width: 440, height: 956 });
  assert.deepEqual(logicalDimensions(landscape, { width: 2868, height: 1320 }), { width: 956, height: 440 });
  assert.throws(() => logicalDimensions(portrait, { width: 2868, height: 1320 }), /window bounds/);
  assert.throws(() => logicalDimensions(' Other, {{0, 0}, {440, 956}}'), /window bounds/);
});

test('appearance queries parse actual native values and leave missing values unknown', () => {
  assert.deepEqual(appearanceSettings(JSON.stringify(nativeAppearance)), {
    appearance: 'light', textSize: 'large', increasedContrast: false, reduceMotion: false, reduceTransparency: false,
  });
  assert.deepEqual(appearanceSettings(JSON.stringify({ result: { textSize: 'Accessibility Extra Extra Large', userInterfaceStyle: 'automatic' } })), { textSize: 'accessibility-extra-extra-large' });
  assert.equal(appearanceSettings(JSON.stringify({ result: { textSize: 'Unknown', reduceMotion: {} } })), undefined);
});

test('keyboard text is literal even when it contains command syntax, escapes or Unicode', () => {
  assert.equal(keyboardCommand('a \\\n🙂'), String.raw`sender keyboard kbd \u{61}\u{20}\u{5c}\u{a}\u{1f642}`);
  assert.throws(() => appleToolData({ isError: true, content: [{ type: 'text', text: 'Native error.' }] }), /Native error/);
  assert.deepEqual(appleToolData({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
});

test('sessions hide native secrets and AX disabled captures use screenshot commands only', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  assert.notEqual(session.id, 'secret-key');
  assert.equal(JSON.stringify(session).includes('secret-key'), false);
  const first = await f.hub.capture(session.id, { accessibilityEnabled: false });
  const second = await f.hub.capture(session.id);
  assert.equal(first.session.accessibilityEnabled, false);
  assert.equal(first.hierarchy, undefined);
  assert.deepEqual(second.coordinateSpace, { width: 440, height: 956 });
  assert.equal(f.calls.filter((call) => call.name === 'DeviceInteractionSynthesize').length, 1);
  assert.equal(f.commands.filter((args) => args.includes('screenshot')).length, 2);
  assert.equal(JSON.stringify(first).includes(f.screenshotPath), false);
  assert.equal(first.settings?.appearance, 'light');
  f.setAppearance({ result: { userInterfaceStyle: 'dark', reduceMotion: { enabled: true } } });
  assert.deepEqual((await f.hub.capture(session.id)).settings, { appearance: 'dark', reduceMotion: true });
  f.setAppearance(undefined);
  assert.equal((await f.hub.capture(session.id)).settings, undefined);
  await f.hub.disconnect(session.id);
  assert.equal(f.calls.at(-1)?.name, 'DeviceInteractionEndSession');
  await assert.rejects(f.hub.capture(session.id), (error) => error instanceof SessionExpiredError && error.code === 'SESSION_EXPIRED');
});

test('reconnects and different devices use unique native session identifiers', async (t) => {
  const f = await fixture(t);
  const first = await f.hub.connect('sim-1');
  await f.hub.disconnect(first.id);
  const second = await f.hub.connect('sim-1');
  await f.hub.connect('physical-1');
  assert.notEqual(first.id, second.id);
  const identifiers = f.calls.filter((call) => call.name === 'DeviceInteractionStartSession').map((call) => call.args.sessionIdentifier);
  assert.equal(new Set(identifiers).size, 3, 'Xcode retains recently used names after EndSession.');
  assert.ok(identifiers.every((value) => /^Apple Device Hub [0-9A-F]{8}$/.test(String(value))));
});

test('concurrent connects reuse a single native session and actions serialize', async (t) => {
  const f = await fixture(t);
  const [session, duplicate] = await Promise.all([f.hub.connect('sim-1'), f.hub.connect('sim-1')]);
  assert.equal(session.id, duplicate.id);
  assert.equal(f.calls.filter((call) => call.name === 'DeviceInteractionStartSession').length, 1);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  f.setToolHook(async (_name, args) => {
    if (args.interactionCommand === 't 100 200') { started(); await hold; }
    return undefined;
  });
  const tap = f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, { settle: false });
  const swipe = f.hub.action(session.id, { type: 'swipe', x: 200, y: 700, toX: 200, toY: 300, duration: 0.4 }, { settle: false });
  await waiting;
  assert.equal(f.calls.some((call) => call.args.interactionCommand === 't 200 700 f 200 300 0.4'), false);
  release(); await Promise.all([tap, swipe]);
  assert.deepEqual(f.calls.slice(-2).map((call) => call.args.interactionCommand), ['t 100 200', 't 200 700 f 200 300 0.4']);
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 10000, y: 200 }), /outside/);
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 440, y: 200 }), /outside/);
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 439.99, y: 200 }), /outside/);
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 100, y: 956 }), /outside/);
});

test('an accessibility retry observes again without repeating an executed action', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  f.setToolHook(async (_name, args) => args.interactionCommand === 't 100 200'
    ? { structuredContent: { screenshotPath: f.screenshotPath } } : undefined);
  await f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, { settle: false });
  assert.deepEqual(f.calls.slice(-2).map((call) => call.args.interactionCommand), ['t 100 200', '']);
});

test('external rotation refreshes logical coordinates while AX stays hidden', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  await f.hub.capture(session.id, { accessibilityEnabled: false });
  f.setScreen(png(2868, 1320));
  await writeFile(f.screenshotPath, png(2868, 1320)); await writeFile(f.hierarchyPath, landscape);
  const capture = await f.hub.capture(session.id);
  assert.deepEqual(capture.coordinateSpace, { width: 956, height: 440 });
  assert.equal(capture.hierarchy, undefined);
  assert.equal(capture.session.accessibilityEnabled, false);
});

test('failed hierarchy observations do not mix a new orientation with old logical coordinates', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  await writeFile(f.hierarchyPath, landscape);
  await assert.rejects(f.hub.capture(session.id), /window bounds/);
  const recovered = await f.hub.capture(session.id, { accessibilityEnabled: false });
  assert.equal(recovered.deviceOrientation, 'Portrait');
  assert.deepEqual(recovered.coordinateSpace, { width: 440, height: 956 });
});

test('device orientation remains observable when the application stays portrait and the tree is hidden', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  await writeFile(f.hierarchyPath, portrait.replace('Device orientation: Portrait', 'Device orientation: Landscape Left'));
  const rotated = await f.hub.action(session.id, { type: 'orientation', orientation: 'landscapeLeft' });
  assert.equal(rotated.deviceOrientation, 'Landscape Left');
  assert.deepEqual(rotated.coordinateSpace, { width: 440, height: 956 });
  const hidden = await f.hub.capture(session.id, { accessibilityEnabled: false });
  assert.equal(hidden.deviceOrientation, 'Landscape Left');
  assert.equal(hidden.hierarchy, undefined);
});

test('failed initial hierarchy capture closes the newly created native session', async (t) => {
  const f = await fixture(t);
  f.setToolHook(async (name) => name === 'DeviceInteractionSynthesize'
    ? { structuredContent: { screenshotPath: f.screenshotPath } } : undefined);
  await assert.rejects(f.hub.connect('sim-1'), /hierarchy is temporarily unavailable/);
  assert.equal(f.calls.at(-1)?.name, 'DeviceInteractionEndSession');
  assert.equal((await f.hub.status()).sessions.length, 0);
});

test('settings use documented argument contracts for simulator and physical devices', async (t) => {
  const f = await fixture(t);
  const simulatorSession = await f.hub.connect('sim-1');
  await f.hub.settings(simulatorSession.id, { appearance: 'dark', textSize: 'large', increasedContrast: true, reduceMotion: true });
  assert.ok(f.commands.some((args) => args.join(' ') === 'simctl ui sim-1 appearance dark'));
  assert.ok(f.commands.some((args) => args.includes('--reduce-motion') && args.at(-1) === 'on'));
  const physicalSession = await f.hub.connect('physical-1');
  await f.hub.settings(physicalSession.id, { textSize: 'accessibility-large', reduceTransparency: false });
  const physical = f.commands.find((args) => args.includes('--larger-accessibility-sizes'))!;
  assert.ok(physical.includes('physical-1'));
  assert.deepEqual(physical.slice(physical.indexOf('--larger-accessibility-sizes')), ['--larger-accessibility-sizes', 'on', '--text-size', 'accessibility-large', '--reduce-transparency', 'off']);
  await f.hub.settings(physicalSession.id, { textSize: 'large' });
  assert.deepEqual(f.commands.filter((args) => args.includes('settings')).at(-1)?.slice(-4), ['--larger-accessibility-sizes', 'off', '--text-size', 'large']);
});

test('idle sessions close and active queued work prevents premature expiry', async (t) => {
  const f = await fixture(t, 25);
  const session = await f.hub.connect('sim-1');
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  f.setToolHook(async (_name, args) => {
    if (args.interactionCommand === 't 100 200') { started(); await hold; }
    return undefined;
  });
  const capture = f.hub.capture(session.id);
  const tap = f.hub.action(session.id, { type: 'tap', x: 100, y: 200 });
  await waiting; await capture;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(f.calls.some((call) => call.name === 'DeviceInteractionEndSession'), false);
  release(); await tap;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(f.calls.filter((call) => call.name === 'DeviceInteractionEndSession').length, 1);
  await assert.rejects(f.hub.capture(session.id), /expired or disconnected/);
});

test('shutdown closes the bridge even if native EndSession fails', async (t) => {
  const f = await fixture(t);
  await f.hub.connect('sim-1');
  f.setToolHook(async (name) => name === 'DeviceInteractionEndSession'
    ? { isError: true, content: [{ type: 'text', text: 'Xcode disconnected.' }] } : undefined);
  await assert.rejects(f.hub.close(), /Xcode disconnected/);
  assert.equal(f.closed, true);
  await assert.rejects(f.hub.connect('sim-1'), /Hub is closed/);
});

test('image headers report JPEG and PNG dimensions', () => {
  assert.deepEqual(jpegDimensions(jpeg(644, 1400)), { width: 644, height: 1400 });
  assert.deepEqual(imageInfo(jpeg()), { mimeType: 'image/jpeg', width: 644, height: 1400 });
  assert.deepEqual(imageInfo(png()), { mimeType: 'image/png', width: 1320, height: 2868 });
  assert.throws(() => jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /no frame header/);
});

test('live frames are compressed screenshots without hierarchy or settings queries', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  const synthesized = f.calls.filter((call) => call.name === 'DeviceInteractionSynthesize').length;
  const queries = f.commands.filter((args) => args.includes('appearance')).length;
  f.setCompressed(jpeg());
  const frame = await f.hub.frame(session.id);
  assert.deepEqual({ ...frame.screenshot, data: undefined }, { mimeType: 'image/jpeg', width: 644, height: 1400, data: undefined });
  assert.deepEqual(frame.coordinateSpace, { width: 440, height: 956 });
  assert.equal(frame.hierarchy, undefined);
  assert.equal(frame.settings, undefined);
  assert.ok(f.commands.at(-1)!.includes('--type=jpeg'));
  assert.equal(f.calls.filter((call) => call.name === 'DeviceInteractionSynthesize').length, synthesized);
  assert.equal(f.commands.filter((args) => args.includes('appearance')).length, queries);
  // Without a compressor the raw capture is sent instead of dropping the frame.
  f.setCompressed(undefined);
  assert.equal((await f.hub.frame(session.id)).screenshot!.mimeType, 'image/png');
});

test('a rotated live frame falls back to a full observation for new coordinates', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  f.setCompressed(jpeg(1400, 644));
  await writeFile(f.screenshotPath, png(2868, 1320)); await writeFile(f.hierarchyPath, landscape);
  const frame = await f.hub.frame(session.id);
  assert.deepEqual(frame.coordinateSpace, { width: 956, height: 440 });
  assert.equal(frame.screenshot!.mimeType, 'image/png');
  assert.equal(frame.hierarchy, landscape);
});

const settingsHierarchy = readFileSync(new URL('./fixtures/settings-hierarchy.txt', import.meta.url), 'utf8');

test('actions target elements by ref or label and observe again once the screen is idle', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const capture = await f.hub.capture(session.id);
  assert.equal(capture.bundleId, 'com.apple.Preferences');
  const general = capture.elements!.find((element) => element.label === 'General')!;
  assert.equal(general.role, 'Button');

  await f.hub.action(session.id, { type: 'tap', element: { ref: general.ref } });
  const commands = f.calls.filter((call) => call.name === 'DeviceInteractionSynthesize').slice(-2).map((call) => call.args.interactionCommand);
  assert.deepEqual(commands, ['t 201 406.3', ''], 'the settled observation follows the tap');
  assert.ok(f.commands.filter((args) => args.includes('--type=jpeg')).length >= 2, 'idle detection compares quick screenshots');

  await f.hub.action(session.id, { type: 'tap', element: { label: 'accessibility', role: 'Button' } }, { settle: false });
  assert.equal(f.calls.at(-1)?.args.interactionCommand, 't 201 458.3');
  await assert.rejects(f.hub.action(session.id, { type: 'tap', element: { ref: 'e999' } }), /No element e999/);
  await assert.rejects(f.hub.action(session.id, { type: 'tap', element: { label: 'Search' } }), /elements match/);
  await assert.rejects(f.hub.action(session.id, { type: 'tap' }), /element target or both x and y/);

  await f.hub.action(session.id, { type: 'type', text: 'wifi', element: { role: 'SearchField', label: 'Search' } }, { settle: false });
  const typed = f.calls.slice(-2).map((call) => call.args.interactionCommand);
  assert.deepEqual(typed, ['t 201 822', 'sender keyboard kbd \\u{77}\\u{69}\\u{66}\\u{69}']);

  await f.hub.action(session.id, { type: 'launchApp', bundleId: 'com.apple.mobilesafari' }, { settle: false });
  assert.equal(f.calls.at(-1)?.args.activationBundleId, 'com.apple.mobilesafari');
});

test('snapshot ids remain stable across equivalent captures', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const first = await f.hub.capture(session.id);
  assert.equal((await f.hub.capture(session.id)).snapshot, first.snapshot);
  await writeFile(f.hierarchyPath, portrait);
  const changed = await f.hub.capture(session.id);
  assert.notEqual(changed.snapshot, first.snapshot);
  assert.equal((await f.hub.capture(session.id, { accessibilityEnabled: false })).elements, undefined);
});

test('scroll directions follow the content and stay inside the target', () => {
  const bounds = { width: 402, height: 874 };
  const screen = scrollRegion(undefined, bounds);
  const down = scrollGesture(screen, 'down', 0.6);
  assert.ok(down.from.y > down.to.y, 'revealing content below moves the finger up');
  assert.equal(down.from.x, 200.5);
  const right = scrollGesture(scrollRegion({ x: 26, y: 90, width: 164, height: 164 }, bounds), 'right', 1);
  assert.ok(right.from.x > right.to.x && right.from.x <= 190 && right.to.x >= 26);
  assert.throws(() => scrollRegion({ x: 0, y: 900, width: 402, height: 100 }, bounds), /not visible/);
});

test('agent captures are resized to logical points when a compressor is available', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  f.setCompressed(jpeg(440, 956));
  const agent = await f.hub.capture(session.id);
  assert.deepEqual([agent.screenshot!.mimeType, agent.screenshot!.width, agent.screenshot!.height], ['image/jpeg', 440, 956]);
  const viewer = await f.hub.capture(session.id, { resolution: 'full' });
  assert.deepEqual([viewer.screenshot!.mimeType, viewer.screenshot!.width], ['image/png', 1320]);
});

test('auto screenshots attach an image only when the element list cannot describe the screen', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const described = await f.hub.capture(session.id, { screenshot: 'auto' });
  assert.ok(described.elements!.length >= 3);
  assert.equal(described.screenshot, undefined);
  assert.equal((await f.hub.action(session.id, { type: 'button', button: 'home' }, { settle: false, screenshot: 'auto' })).screenshot, undefined);
  assert.ok((await f.hub.capture(session.id, { screenshot: 'auto', accessibilityEnabled: false })).screenshot, 'a screen without elements needs its image');
  assert.equal((await f.hub.capture(session.id, { screenshot: 'never', accessibilityEnabled: false })).screenshot, undefined);
  await writeFile(f.hierarchyPath, portrait);
  assert.ok((await f.hub.capture(session.id, { screenshot: 'auto' })).screenshot, 'a nearly empty element list is not a description');
  assert.ok((await f.hub.capture(session.id)).screenshot, 'the viewer default always includes the image');
});

test('a windowless observation while the device starts keeps the previous coordinate space', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  await writeFile(f.hierarchyPath, 'Device orientation: Unknown\nApplication bundle identifier: com.apple.springboard\n');
  const capture = await f.hub.capture(session.id);
  assert.deepEqual(capture.coordinateSpace, { width: 440, height: 956 });
});

test('requests stuck behind an unresponsive device return before the host timeout and never run late', async (t) => {
  const f = await fixture(t, 60_000, undefined, 150);
  const session = await f.hub.connect('sim-1');
  let release!: () => void;
  const stuck = new Promise<void>(resolve => { release = resolve; });
  f.setToolHook(async (name, args) => {
    if (name === 'DeviceInteractionSynthesize' && args.interactionCommand === 't 100 200') await stuck;
    return undefined;
  });
  const first = f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, { settle: false });
  const queued = f.hub.action(session.id, { type: 'tap', x: 300, y: 300 }, { settle: false });
  await assert.rejects(first, /did not finish within/);
  await assert.rejects(queued, /still busy/);
  release();
  await f.hub.capture(session.id);
  assert.equal(f.calls.some(call => call.args.interactionCommand === 't 300 300'), false, 'an abandoned request never sends its input');
});

test('double taps and holds use the native grammar and reject incompatible input before mutation', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  await f.hub.action(session.id, { type: 'tap', x: 100, y: 200, clickCount: 2 }, { settle: false });
  await f.hub.action(session.id, { type: 'tap', x: 100, y: 200, duration: 0.8 }, { settle: false });
  assert.deepEqual(f.calls.slice(-2).map(call => call.args.interactionCommand), ['d 100 200', 't 100 200 0.8']);
  const count = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 100, y: 200, clickCount: 2, duration: 0.8 }), /double tap cannot/);
  assert.equal(f.calls.length, count);
  for (const type of ['tap', 'scroll', 'type']) {
    const fields = { direction: 'down', text: 'hello' };
    assert.equal(actionSchema.safeParse({ type, ...fields, x: 100 }).success, false);
    assert.equal(actionSchema.safeParse({ type, ...fields, x: 100, y: 200, element: { ref: 'e1' } }).success, false);
  }
});

test('simulator keyboard keys and hardware buttons map to constrained native commands', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  for (const key of ['Return', 'Tab', 'Backspace', 'Home', 'Lock', 'VolumeUp', 'VolumeDown'] as const) {
    await f.hub.action(session.id, { type: 'pressKey', key }, { settle: false, simulatorOnly: true });
  }
  assert.deepEqual(f.calls.slice(-7).map(call => call.args.interactionCommand), [
    String.raw`sender keyboard kbd \u{a}`, String.raw`sender keyboard kbd \u{9}`, String.raw`sender keyboard kbd \u{8}`,
    'b h', 'b p', 'b u', 'b d',
  ]);
  assert.equal(actionSchema.safeParse({ type: 'pressKey', key: 'Cmd+A' }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'pressKey', key: 'ArrowUp' }).success, false);
});

test('coordinate scroll starts at its requested point and clamps the endpoint', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  await f.hub.action(session.id, { type: 'scroll', direction: 'down', x: 200, y: 300, distance: 0.6 }, { settle: false });
  assert.equal(f.calls.at(-1)?.args.interactionCommand, 't 200 300 f 200 0 0.5');
  await f.hub.action(session.id, { type: 'scroll', direction: 'right', x: 400, y: 300, distance: 0.6 }, { settle: false });
  assert.equal(f.calls.at(-1)?.args.interactionCommand, 't 400 300 f 136 300 0.5');
  assert.throws(() => scrollFromPoint({ x: 200, y: 0 }, { width: 440, height: 956 }, 'down', 0.6), /no room/);
  const count = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'scroll', direction: 'down', x: 440, y: 300, distance: 0.6 }), /outside/);
  assert.equal(f.calls.length, count);
});

test('coordinate typing keeps focus and text input in one serialized operation', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.setToolHook(async (_name, args) => {
    if (args.interactionCommand === 't 100 200') { started(); await hold; }
    return undefined;
  });
  const typed = f.hub.action(session.id, { type: 'type', x: 100, y: 200, text: 'hi' }, { settle: false });
  const home = f.hub.action(session.id, { type: 'pressKey', key: 'Home' }, { settle: false });
  await waiting;
  assert.equal(f.calls.some(call => call.args.interactionCommand === 'b h'), false);
  release();
  await Promise.all([typed, home]);
  assert.deepEqual(f.calls.slice(-3).map(call => call.args.interactionCommand), ['t 100 200', keyboardCommand('hi'), 'b h']);
});

test('simulator-only operations reject physical sessions before capture or input', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('physical-1');
  const calls = f.calls.length;
  const commands = f.commands.length;
  await assert.rejects(f.hub.capture(session.id, { simulatorOnly: true }), /require a simulator session/);
  await assert.rejects(f.hub.action(session.id, { type: 'pressKey', key: 'Home' }, { simulatorOnly: true }), /require a simulator session/);
  await assert.rejects(f.hub.settings(session.id, { appearance: 'dark' }, { simulatorOnly: true }), /require a simulator session/);
  assert.equal(f.calls.length, calls);
  assert.equal(f.commands.length, commands);
});

test('computer-use observations expose requested elements without changing the viewer preference', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  await f.hub.capture(session.id, { accessibilityEnabled: false });
  const state = await f.hub.capture(session.id, { accessibilityEnabled: true, updateAccessibilityPreference: false, simulatorOnly: true });
  assert.ok(state.elements!.length > 0);
  assert.equal(state.session.accessibilityEnabled, false);
  const action = await f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, { accessibilityEnabled: true, settle: false });
  assert.ok(action.elements!.length > 0);
  assert.equal(action.session.accessibilityEnabled, false);
  const next = await f.hub.capture(session.id);
  assert.equal(next.elements, undefined);
  assert.equal(next.hierarchy, undefined);
  await f.hub.capture(session.id, { accessibilityEnabled: true });
  const screen = await f.hub.capture(session.id, { accessibilityEnabled: false, updateAccessibilityPreference: false });
  assert.equal(screen.hierarchy, undefined);
  assert.equal(screen.session.accessibilityEnabled, true);
});

test('settings mutations invalidate element snapshots even when the viewer hides accessibility', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const observed = await f.hub.capture(session.id);
  const general = observed.elements!.find(element => element.label === 'General')!;
  await f.hub.capture(session.id, { accessibilityEnabled: false });
  assert.equal((await f.hub.settings(session.id, {})).snapshot, observed.snapshot);
  const changed = await f.hub.settings(session.id, { textSize: 'accessibility-large' });
  assert.equal(changed.snapshot, undefined);
  const count = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'tap', element: { ref: general.ref } }, { snapshot: observed.snapshot }), /snapshot is stale/);
  assert.deepEqual(f.calls.slice(count).map(call => call.args.interactionCommand), ['']);
  const fresh = await f.hub.capture(session.id, { accessibilityEnabled: true, updateAccessibilityPreference: false });
  assert.notEqual(fresh.snapshot, observed.snapshot);
});

test('snapshot guards are checked when queued input executes and stale refs never send input', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const capture = await f.hub.capture(session.id);
  const general = capture.elements!.find(element => element.label === 'General')!;
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.setToolHook(async (_name, args) => {
    if (args.interactionCommand === 't 100 200') {
      started(); await hold;
      await writeFile(f.hierarchyPath, portrait);
    }
    return undefined;
  });
  const first = f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, { settle: false });
  const stale = f.hub.action(session.id, { type: 'tap', element: { ref: general.ref } }, { snapshot: capture.snapshot, settle: false, simulatorOnly: true });
  const rejected = assert.rejects(stale, /snapshot is stale/);
  await waiting;
  const count = f.calls.length;
  release();
  await first; await rejected;
  assert.deepEqual(f.calls.slice(count).map(call => call.args.interactionCommand), [''], 'the second queued action only observes and never sends input');
});

test('failed input observations never replay input and invalidate the previous snapshot', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const capture = await f.hub.capture(session.id);
  const general = capture.elements!.find(element => element.label === 'General')!;
  f.setToolHook(async name => name === 'DeviceInteractionSynthesize'
    ? { structuredContent: { screenshotPath: f.screenshotPath } } : undefined);
  const count = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, { settle: false }), /hierarchy is temporarily unavailable/);
  assert.deepEqual(f.calls.slice(count).map(call => call.args.interactionCommand), ['t 100 200', '', '']);
  f.setToolHook(undefined);
  const failedCount = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'tap', element: { ref: general.ref } }, { snapshot: capture.snapshot }), /snapshot is stale/);
  assert.deepEqual(f.calls.slice(failedCount).map(call => call.args.interactionCommand), ['']);
  const recovered = await f.hub.capture(session.id);
  assert.notEqual(recovered.snapshot, capture.snapshot);
});

test('snapshot-protected actions re-observe external navigation before trusting refs', async (t) => {
  const f = await fixture(t);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const observed = await f.hub.capture(session.id);
  const general = observed.elements!.find(element => element.label === 'General')!;
  await f.hub.capture(session.id, { accessibilityEnabled: false });
  // Manual navigation can change the native state without any hub operation.
  await writeFile(f.hierarchyPath, portrait);
  const count = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'tap', element: { ref: general.ref } }, {
    snapshot: observed.snapshot, settle: false, simulatorOnly: true, accessibilityEnabled: true,
  }), /snapshot is stale/);
  assert.deepEqual(f.calls.slice(count).map(call => call.args.interactionCommand), ['']);
  assert.equal((await f.hub.status()).sessions[0]?.accessibilityEnabled, false);
});

test('snapshot-protected coordinates reject external rotation even with no accessibility elements', async (t) => {
  const f = await fixture(t);
  const session = await f.hub.connect('sim-1');
  const observed = await f.hub.capture(session.id);
  assert.equal(observed.elements!.length, 0);
  await writeFile(f.screenshotPath, png(2868, 1320));
  await writeFile(f.hierarchyPath, landscape);
  const count = f.calls.length;
  await assert.rejects(f.hub.action(session.id, { type: 'tap', x: 100, y: 200 }, {
    snapshot: observed.snapshot, settle: false, simulatorOnly: true,
  }), /snapshot is stale/);
  assert.deepEqual(f.calls.slice(count).map(call => call.args.interactionCommand), ['']);
  const fresh = await f.hub.capture(session.id);
  assert.deepEqual(fresh.coordinateSpace, { width: 956, height: 440 });
  assert.notEqual(fresh.snapshot, observed.snapshot);
});

test('shutdown during discovery prevents a new native connection and repeated shutdown shares cleanup', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const command = f.boundary.command;
  f.boundary.command = async (args, timeoutMs) => {
    if (args[0] === 'simctl' && args[1] === 'list') { started(); await hold; }
    return command(args, timeoutMs);
  };
  const connecting = f.hub.connect('sim-1');
  const rejected = assert.rejects(connecting, /Hub is closed/);
  await waiting;
  const close = f.hub.close();
  assert.equal(f.hub.close(), close);
  release();
  await rejected; await close;
  assert.equal(f.calls.some(call => call.name === 'DeviceInteractionStartSession'), false);
  assert.equal(f.closed, true);
});

test('shutdown during native connection closes the returned native session without publishing success', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.setToolHook(async name => {
    if (name === 'DeviceInteractionStartSession') { started(); await hold; }
    return undefined;
  });
  const connecting = f.hub.connect('sim-1');
  const rejected = assert.rejects(connecting, SessionExpiredError);
  await waiting;
  const close = f.hub.close();
  release();
  await rejected; await close;
  assert.equal(f.calls.filter(call => call.name === 'DeviceInteractionSynthesize').length, 0);
  assert.equal(f.calls.filter(call => call.name === 'DeviceInteractionEndSession').length, 1);
  assert.equal(f.closed, true);
});

test('live stream reads run alongside input and prevent idle expiry while pending', async (t) => {
  const video = new SimulatorVideo();
  let release!: (value: VideoBatch) => void;
  const batch = new Promise<VideoBatch>(resolve => { release = resolve; });
  video.read = async () => batch;
  const stops: string[][] = [];
  video.stop = (sessionId, streamId) => { stops.push([sessionId, streamId]); };
  const f = await fixture(t, 25, video);
  const session = await f.hub.connect('sim-1');
  const reading = f.hub.streamRead(session.id, 'live-stream');
  await f.hub.action(session.id, { type: 'pressKey', key: 'Home' }, { settle: false });
  assert.equal(f.calls.at(-1)?.args.interactionCommand, 'b h', 'input does not wait for a live batch');
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.calls.some(call => call.name === 'DeviceInteractionEndSession'), false);
  const result: VideoBatch = { sessionId: session.id, streamId: 'live-stream', sequence: 0, frames: [], active: true };
  release(result);
  assert.equal(await reading, result);
  await f.hub.streamStop(session.id, 'live-stream');
  assert.deepEqual(stops, [[session.id, 'live-stream']]);
});

test('device activity reaches each live viewer once and never repeats typed text', async (t) => {
  const video = new SimulatorVideo();
  video.stream = async (sessionId) => ({ sessionId, streamId: 'a'.repeat(48), url: 'ws://127.0.0.1:1/video/test', format: 'h264', codec: 'avc1.42E01F', fps: 60 });
  let sequence = 0;
  video.read = async (sessionId, streamId) => ({ sessionId, streamId, sequence: sequence++, frames: [], active: true });
  const f = await fixture(t, 60_000, video);
  await writeFile(f.hierarchyPath, settingsHierarchy);
  const session = await f.hub.connect('sim-1');
  const general = (await f.hub.capture(session.id)).elements!.find(element => element.label === 'General')!;
  await f.hub.action(session.id, { type: 'tap', x: 10, y: 20 }, { settle: false });
  const stream = await f.hub.stream(session.id);
  await f.hub.action(session.id, { type: 'tap', element: { ref: general.ref } }, { settle: false });
  await f.hub.action(session.id, { type: 'type', text: 'correct horse battery' }, { settle: false });
  const batch = await f.hub.streamRead(session.id, stream.streamId!);
  assert.deepEqual(batch.activity?.map(item => ({ summary: item.summary, ref: item.ref, point: item.point })), [
    { summary: 'Tap “General”', ref: general.ref, point: general.point },
    { summary: 'Type text', ref: undefined, point: undefined },
  ], 'actions from before the stream started are not replayed');
  assert.equal(JSON.stringify(batch).includes('horse'), false);
  assert.equal((await f.hub.streamRead(session.id, stream.streamId!)).activity, undefined, 'each action is delivered once');
});

test('live stream reads guard simulator ownership and reject results after disconnect', async (t) => {
  const video = new SimulatorVideo();
  let reads = 0;
  let stops = 0;
  let release!: (value: VideoBatch) => void;
  const batch = new Promise<VideoBatch>(resolve => { release = resolve; });
  video.read = async () => { reads++; return batch; };
  video.stop = () => { stops++; };
  const f = await fixture(t, 60_000, video);
  const physical = await f.hub.connect('physical-1');
  await assert.rejects(f.hub.streamRead(physical.id, 'stream'), /supports Apple simulators/);
  await assert.rejects(f.hub.streamStop(physical.id, 'stream'), /supports Apple simulators/);
  await assert.rejects(f.hub.streamRead('missing-session', 'stream'), SessionExpiredError);
  assert.equal(reads, 0);
  assert.equal(stops, 0);
  const session = await f.hub.connect('sim-1');
  const reading = f.hub.streamRead(session.id, 'stream');
  const rejected = assert.rejects(reading, SessionExpiredError);
  await f.hub.disconnect(session.id);
  release({ sessionId: session.id, streamId: 'stream', sequence: 0, frames: [], active: true });
  await rejected;
  assert.equal(reads, 1);
  await assert.rejects(f.hub.streamStop(session.id, 'stream'), SessionExpiredError);
  assert.equal(stops, 0);
});

test('relay errors after device disconnect report session expiry to the viewer', async (t) => {
  const video = new SimulatorVideo();
  let reject!: (error: Error) => void;
  const batch = new Promise<VideoBatch>((_resolve, rejectPromise) => { reject = rejectPromise; });
  video.read = async () => batch;
  const f = await fixture(t, 60_000, video);
  const session = await f.hub.connect('sim-1');
  const reading = f.hub.streamRead(session.id, 'stream');
  const rejected = assert.rejects(reading, (error: unknown) => error instanceof SessionExpiredError && error.code === 'SESSION_EXPIRED');
  await f.hub.disconnect(session.id);
  reject(new Error('Simulator video stream stopped.'));
  await rejected;
});

test('live input reaches the simulator helper without Xcode or the serial device queue', async (t) => {
  const video = new SimulatorVideo();
  const inputs: unknown[] = [];
  video.input = (sessionId, events) => { inputs.push([sessionId, events]); };
  const f = await fixture(t, 60_000, video);
  const physical = await f.hub.connect('physical-1');
  await assert.rejects(f.hub.input(physical.id, [{ type: 'home', dt: 0 }]), /supports Apple simulators/);
  await assert.rejects(f.hub.input('missing-session', [{ type: 'home', dt: 0 }]), SessionExpiredError);
  const session = await f.hub.connect('sim-1');
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  f.setToolHook(async name => {
    if (name === 'DeviceInteractionSynthesize') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return undefined;
  });
  const observing = f.hub.capture(session.id);
  await blocked;
  const calls = f.calls.length;
  await f.hub.input(session.id, [{ type: 'down', x: 0.5, y: 0.25, dt: 0 }]);
  assert.deepEqual(inputs, [[session.id, [{ type: 'down', x: 0.5, y: 0.25, dt: 0 }]]], 'input is delivered while an observation is pending');
  assert.equal(f.calls.length, calls);
  release();
  await observing;
});
