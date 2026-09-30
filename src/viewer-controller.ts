import { App } from "@modelcontextprotocol/ext-apps";
import { version } from "./version.js";
import { applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { OpenAIExtensions, OPENAI_MODEL_CONTEXT_KEY } from "@openai/mcp-extensions/app";
import { HIERARCHY_META_KEY, sessionSchema, type CaptureState, type DeviceAction, type DeviceSettings, type HubState, type LiveInput, type Session } from "./shared.js";
import { screenToDevicePoint } from "./screen-mapping.js";
import { coordinateSpaceMatchesFrame, SimulatorVideoPlayer, type SimulatorStream, type SimulatorVideoTransport } from "./video-player.js";
import { preferredVideoCodec, type VideoCodec } from "./video-codec.js";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;
type ScreenImage = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };
type PreviewWindow = Window & { __APPLE_DEVICE_HUB_PREVIEW__?: boolean };

const preview = (window as PreviewWindow).__APPLE_DEVICE_HUB_PREVIEW__ === true;
const useVideoRelay = !preview || new URLSearchParams(window.location.search).get("transport") === "mcp";
const app = new App({ name: "apple-device-hub", version });
const extensions = new OpenAIExtensions(app);
let root: HTMLElement;
let screen: HTMLImageElement;
let videoCanvas: HTMLCanvasElement;
let screenFrame: HTMLElement;
let gestureMark: HTMLElement;
let selectedDeviceId = "";
let liveEnabled = true;
let inspecting = false;
let pickElement: ((point: { x: number; y: number }) => void) | undefined;
let videoReady = false;
let settingsOpen = false;
let hub: HubState = { devices: [], sessions: [], warnings: [] };
let session: Session | undefined;
let capture: CaptureState | undefined;
let screenImage: ScreenImage | undefined;
let busy = false;
let initialized = false;
let ended = false;
let visible = true;
let lifecycle = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let videoPlayer: SimulatorVideoPlayer | undefined;
let videoSessionId: string | undefined;
let videoStarting = false;
let videoGeneration = 0;
let videoFailures = 0;
let h264Fallback = false;
let lastVideoError = "";
let videoRetryTimer: ReturnType<typeof setTimeout> | undefined;
let videoObservationTimer: ReturnType<typeof setTimeout> | undefined;
let videoDimensions: { width: number; height: number } | undefined;
let videoRequestedDimension: number | undefined;
let videoSizeFloor: number | undefined;
let coordinateRefreshPending = false;
let lastCoordinateRefresh = 0;
let disconnecting = false;
// Live frames run outside run() so they never lock controls; a user action bumps
// the generation so any frame requested before it cannot overwrite its result.
let streaming = false;
let frameGeneration = 0;
let frameFailures = 0;
let lastFrameData: string | undefined;
let lastFrameUnchanged = false;
let staleSince: number | undefined;
let contextEnabled = false;
const retiredSessionIds = new Set<string>();
let attachedAt: string | undefined;
let observedSettings: DeviceSettings = {};
let pointerStart: { id: number; x: number; y: number; clientX: number; clientY: number; time: number; epoch: number; width: number; height: number } | undefined;
// Live input streams touches to the simulator while the pointer moves; Xcode input remains the fallback.
let liveTouch: { id: number; epoch: number; point: { x: number; y: number } } | undefined;
let liveQueue: LiveInput[] = [];
let liveSending = false;
let liveInputAt: number | undefined;
let liveInputError: string | undefined;
let renderedAt: number[] = [];
let fpsLabelAt = 0;

export interface ViewerState {
  hub: HubState;
  session?: Session;
  capture?: CaptureState;
  selectedDeviceId: string;
  initialized: boolean;
  busy: boolean;
  ended: boolean;
  liveEnabled: boolean;
  videoReady: boolean;
  /** Touches and Home go straight to the simulator instead of through Xcode. */
  liveInput: boolean;
  videoDimensions?: { width: number; height: number };
  videoMessage: string;
  videoError: boolean;
  notice: string;
  noticeError: boolean;
  settings: DeviceSettings;
  contextEnabled: boolean;
  attachmentStatus: string;
  attached: boolean;
}
let snapshot: ViewerState = {
  hub, selectedDeviceId, initialized, busy, ended, liveEnabled, videoReady, liveInput: false,
  videoMessage: "", videoError: false,
  notice: "Connecting to Device Hub…", noticeError: false,
  settings: {}, contextEnabled, attachmentStatus: "Attach a screen to your next message.", attached: false,
};
const listeners = new Set<() => void>();
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getSnapshot = () => snapshot;

function publish(patch: Partial<ViewerState> = {}) {
  snapshot = { ...snapshot, hub, session, capture, selectedDeviceId, initialized, busy, ended, liveEnabled, videoReady, liveInput: liveInputReady(), videoDimensions, settings: observedSettings, contextEnabled, ...patch };
  listeners.forEach(listener => listener());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function showNotice(message: string, error = false) {
  publish({ notice: message, noticeError: error });
}

function resultError(result: ToolResult) {
  return result.content.filter(item => item.type === "text").map(item => item.text).join("\n") || "Device Hub could not complete this action.";
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  let result: ToolResult;
  if (preview) {
    const response = await fetch("/api/tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
    if (!response.ok) throw new Error(`Device Hub transport failed (${response.status}).`);
    result = await response.json() as ToolResult;
  } else {
    result = await app.callServerTool({ name, arguments: args });
  }
  if (result.isError) {
    if (result._meta?.errorCode === "SESSION_EXPIRED" && result._meta.sessionId === session?.id) clearSession();
    throw new Error(resultError(result));
  }
  return result;
}

function updateControls() { publish(); }

function resetStream() {
  lastFrameData = undefined;
  lastFrameUnchanged = false;
  staleSince = undefined;
  frameFailures = 0;
}

function stopPolling() {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

function canStreamVideo() {
  return !ended && initialized && liveEnabled && !document.hidden && visible && !disconnecting && session?.device.kind === "simulator";
}

function videoStatus(message: string, error = false) {
  if (snapshot.videoMessage !== message || snapshot.videoError !== error) publish({ videoMessage: message, videoError: error });
}

function stopVideo(reset = false) {
  videoGeneration++;
  videoPlayer?.stop();
  videoPlayer = undefined;
  videoSessionId = undefined;
  videoStarting = false;
  // Captures and action results must remain visible after video fails or pauses.
  videoCanvas.hidden = true;
  videoReady = false;
  videoDimensions = undefined;
  videoRequestedDimension = undefined;
  renderedAt = [];
  // The helper lifts a held touch when its video stops.
  if (liveTouch) gestureMark.hidden = true;
  liveTouch = undefined;
  liveQueue = [];
  screenFrame.hidden = !capture;
  if (videoRetryTimer !== undefined) clearTimeout(videoRetryTimer);
  if (videoObservationTimer !== undefined) clearTimeout(videoObservationTimer);
  videoRetryTimer = videoObservationTimer = undefined;
  if (reset) {
    videoFailures = 0;
    lastVideoError = "";
    lastCoordinateRefresh = 0;
    videoSizeFloor = undefined;
  }
  publish();
}

function scheduleVideoObservation(delay = 5000) {
  if (videoObservationTimer !== undefined) clearTimeout(videoObservationTimer);
  videoObservationTimer = undefined;
  if (!canStreamVideo() || !videoPlayer || !session?.accessibilityEnabled) return;
  videoObservationTimer = setTimeout(() => {
    videoObservationTimer = undefined;
    if (busy || pointerStart || liveTouch || settingsOpen) { scheduleVideoObservation(); return; }
    const epoch = lifecycle;
    void captureCurrent(epoch).catch(error => {
      if (epoch === lifecycle && !ended) showNotice(errorMessage(error), true);
    }).finally(() => scheduleVideoObservation());
  }, delay);
}

function refreshVideoCoordinates() {
  if (coordinateRefreshPending || busy || !capture || !videoDimensions || coordinateSpaceMatchesFrame(capture.coordinateSpace, videoDimensions) || performance.now() - lastCoordinateRefresh < 1000) return;
  coordinateRefreshPending = true;
  lastCoordinateRefresh = performance.now();
  const epoch = lifecycle;
  void captureCurrent(epoch).catch(error => {
    if (epoch === lifecycle && !ended) showNotice(errorMessage(error), true);
  }).finally(() => { coordinateRefreshPending = false; });
}

function stopVideoStream(stream: SimulatorStream) {
  if (stream.streamId) void callTool("device_stream_stop", { sessionId: stream.sessionId, streamId: stream.streamId }).catch(() => {});
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * One read is pending at a time. ChatGPT's desktop host runs at most three
 * requests per MCP app at once, and live input must not queue behind video.
 * The server answers as soon as a frame exists, so a single read keeps up at 60 fps.
 */
function videoTransport(stream: SimulatorStream): SimulatorVideoTransport {
  let stopped = false;
  let sequence = 0;
  return {
    async read() {
      const result = await callTool("device_stream_read", { sessionId: stream.sessionId, streamId: stream.streamId });
      if (stopped) return [];
      const batch = result._meta?.["apple-device-hub/video"] as { sessionId?: string; streamId?: string; sequence?: unknown; frames?: unknown; active?: boolean } | undefined;
      if (!batch || batch.sessionId !== stream.sessionId || batch.streamId !== stream.streamId || batch.active !== true || !Array.isArray(batch.frames) || !batch.frames.every(frame => typeof frame === "string")) throw new Error("Device Hub returned an incomplete video batch.");
      // A lost or repeated batch breaks the decoder's reference chain.
      if (batch.sequence !== sequence) throw new Error("Device Hub video batches arrived out of order.");
      sequence++;
      return (batch.frames as string[]).map(decodeBase64);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopVideoStream(stream);
    },
  };
}

/**
 * Video larger than the displayed frame only costs bandwidth and decode time.
 * The still sits under the canvas at the same size. Before the first still,
 * assume portrait, whose long edge is the frame's maximum height.
 */
function videoMaxDimension() {
  const shown = screen.getBoundingClientRect();
  const stage = screenFrame.parentElement;
  const edge = Math.max(shown.width, shown.height) || parseFloat(getComputedStyle(videoCanvas).maxHeight) || Math.max(stage?.clientWidth ?? 0, stage?.clientHeight ?? 0);
  const pixels = Math.max(edge * (window.devicePixelRatio || 1), videoSizeFloor ?? 0);
  return pixels >= 320 ? Math.min(8192, Math.ceil(pixels / 64) * 64) : undefined;
}

/** The size a resized panel or a rotation to landscape needs once it outgrows the stream; the native resolution is the limit. */
function outgrownVideoDimension(dimensions: { width: number; height: number }) {
  const needed = videoMaxDimension();
  if (videoRequestedDimension === undefined || needed === undefined || needed <= videoRequestedDimension * 1.25 || Math.max(dimensions.width, dimensions.height) < videoRequestedDimension - 2) return undefined;
  return needed;
}

async function startVideo() {
  const current = session;
  if (!current || !canStreamVideo() || videoStarting || videoPlayer || videoRetryTimer !== undefined || videoFailures >= 4) return;
  const generation = ++videoGeneration;
  videoStarting = true;
  videoSessionId = current.id;
  videoStatus(videoFailures ? "Reconnecting live video…" : "Starting live video…");
  let transport: SimulatorVideoTransport | undefined;
  let format: VideoCodec = "h264";
  try {
    format = h264Fallback ? "h264" : await preferredVideoCodec();
    if (generation !== videoGeneration || session?.id !== current.id || !canStreamVideo()) return;
    const maxDimension = videoMaxDimension();
    videoRequestedDimension = maxDimension;
    const result = await callTool("device_stream", { sessionId: current.id, codec: format, ...(maxDimension ? { maxDimension } : {}) });
    const stream = result.structuredContent as unknown as SimulatorStream | undefined;
    if (generation !== videoGeneration || session?.id !== current.id || !canStreamVideo()) {
      if (stream?.sessionId === current.id && typeof stream.streamId === "string") stopVideoStream(stream);
      return;
    }
    if (!stream || stream.sessionId !== current.id || typeof stream.url !== "string" || typeof stream.codec !== "string" || !Number.isFinite(stream.fps) || stream.fps <= 0) throw new Error("Device Hub returned an incomplete video stream.");
    if (stream.format !== undefined && stream.format !== format) throw new Error("Device Hub returned a different video codec than requested.");
    // Embedded hosts block loopback WebSockets; video stays on the app's MCP bridge.
    if (useVideoRelay) {
      if (typeof stream.streamId !== "string" || !/^[a-f0-9]{48}$/.test(stream.streamId)) throw new Error("Device Hub returned an incomplete video stream. Reload the updated plugin to reconnect.");
      transport = videoTransport(stream);
    }
    const startedAt = performance.now();
    const player = new SimulatorVideoPlayer(videoCanvas, stream, dimensions => {
      if (generation !== videoGeneration || session?.id !== current.id) return;
      const firstFrame = !videoDimensions || videoDimensions.width !== dimensions.width || videoDimensions.height !== dimensions.height;
      videoDimensions = dimensions;
      if (performance.now() - startedAt > 5000) videoFailures = 0;
      videoCanvas.hidden = false;
      screenFrame.hidden = false;
      videoReady = true;
      if (firstFrame) publish();
      // The helper sends frames only when the screen changes, so the measured rate reports motion.
      const now = performance.now();
      renderedAt.push(now);
      while (renderedAt[0]! < now - 1000) renderedAt.shift();
      if (firstFrame || now - fpsLabelAt >= 1000) {
        fpsLabelAt = now;
        videoStatus(`Live video · ${stream.format === "hevc" ? "HEVC" : "H.264"} · ${renderedAt.length >= 5 ? `${renderedAt.length} fps` : "idle"}`);
        const outgrown = liveTouch ? undefined : outgrownVideoDimension(dimensions);
        if (outgrown) {
          // The restart measures the still, which can lag a rotation; keep the size measured from the live frame.
          videoSizeFloor = outgrown;
          stopVideo();
          schedulePoll();
          return;
        }
      }
      // A rotated frame must never use the preceding portrait touch coordinates.
      if (firstFrame || capture && !coordinateSpaceMatchesFrame(capture.coordinateSpace, dimensions)) refreshVideoCoordinates();
    }, error => {
      if (generation === videoGeneration) failVideo(error, current.id, format);
    }, transport);
    videoPlayer = player;
    videoStarting = false;
    player.start();
    scheduleVideoObservation();
  } catch (error) {
    transport?.stop();
    if (generation === videoGeneration) failVideo(error, current.id, format);
  } finally {
    if (generation === videoGeneration) videoStarting = false;
  }
}

function failVideo(error: unknown, sessionId: string, format: VideoCodec) {
  stopVideo();
  if (format === "hevc" && !h264Fallback && !ended && session?.id === sessionId) {
    h264Fallback = true;
    videoStatus("HEVC unavailable. Switching to H.264…");
    if (canStreamVideo()) videoRetryTimer = setTimeout(() => { videoRetryTimer = undefined; void startVideo(); }, 0);
    else schedulePoll();
    return;
  }
  videoFailures++;
  if (ended || session?.id !== sessionId) return;
  const retrying = canStreamVideo() && videoFailures < 4;
  lastVideoError = errorMessage(error);
  videoStatus(`${lastVideoError}${retrying ? " Retrying…" : ""}`, true);
  if (retrying) videoRetryTimer = setTimeout(() => {
    videoRetryTimer = undefined;
    void startVideo();
  }, Math.min(5000, 500 * 2 ** (videoFailures - 1)));
  else schedulePoll();
}

function syncVideo() {
  const simulator = session?.device.kind === "simulator";
  if (!canStreamVideo()) {
    if (videoStarting || videoPlayer || videoRetryTimer !== undefined) stopVideo();
    if (simulator) videoStatus(liveEnabled ? "Live video paused while this viewer is hidden." : "Live video paused.");
    return;
  }
  if (videoSessionId && videoSessionId !== session?.id) stopVideo(true);
  if (videoFailures >= 4) { videoStatus(lastVideoError || "Live video unavailable. Retry to reconnect.", true); return; }
  void startVideo();
}

function canPoll() {
  return !ended && initialized && liveEnabled && !document.hidden && visible && !busy && !streaming && !pointerStart && !liveTouch && !settingsOpen;
}

function liveInputReady() {
  return videoReady && !liveInputError && !videoCanvas.hidden && canStreamVideo();
}

function resetLiveInput() {
  liveTouch = undefined;
  liveQueue = [];
  liveInputAt = undefined;
  liveInputError = undefined;
}

function queueLiveInput(event: LiveInput) {
  const last = liveQueue.at(-1);
  // A slow host round trip coalesces moves but keeps the gesture's elapsed time.
  if (event.type === "move" && last?.type === "move" && liveQueue.length >= 16) {
    last.x = event.x;
    last.y = event.y;
    last.dt = Math.min(1000, last.dt + event.dt);
  } else liveQueue.push(event);
  void sendLiveInput();
}

function elapsedInput(time: number) {
  const elapsed = liveInputAt === undefined ? 0 : Math.round(Math.max(0, Math.min(1000, time - liveInputAt)));
  liveInputAt = time;
  return elapsed;
}

/** One request is in flight at a time, so batches arrive in order; later events wait for its reply. */
async function sendLiveInput() {
  const current = session;
  if (liveSending || !liveQueue.length || !current) return;
  const events = liveQueue;
  liveQueue = [];
  liveSending = true;
  try {
    await callTool("device_input", { sessionId: current.id, events });
  } catch (error) {
    // Input sent as video stops fails harmlessly; only a failure with video running disables live input.
    if (session?.id === current.id && liveInputReady()) {
      liveInputError = errorMessage(error);
      liveTouch = undefined;
      liveQueue = [];
      gestureMark.hidden = true;
      showNotice(`${liveInputError} Using Xcode input instead.`, true);
    }
  } finally {
    liveSending = false;
    if (liveQueue.length) void sendLiveInput();
  }
}

function framePoint(event: PointerEvent) {
  const rect = videoCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return undefined;
  const fraction = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
  return { x: fraction((event.clientX - rect.left) / rect.width), y: fraction((event.clientY - rect.top) / rect.height) };
}

function eventTime(event: PointerEvent) {
  return Number.isFinite(event.timeStamp) && event.timeStamp > 0 ? event.timeStamp : performance.now();
}

function placeGestureMark(event: PointerEvent) {
  const frame = screenFrame.getBoundingClientRect();
  gestureMark.style.left = `${event.clientX - frame.left}px`;
  gestureMark.style.top = `${event.clientY - frame.top}px`;
  gestureMark.hidden = false;
}

function finishLiveTouch(event: PointerEvent, type: "up" | "cancel") {
  const touch = liveTouch!;
  liveTouch = undefined;
  gestureMark.hidden = true;
  if (screenFrame.hasPointerCapture(event.pointerId)) screenFrame.releasePointerCapture(event.pointerId);
  if (touch.epoch !== lifecycle) return;
  queueLiveInput({ type, ...(framePoint(event) ?? touch.point), dt: elapsedInput(eventTime(event)) });
  // The video already shows the result; refresh elements once the gesture has had time to land.
  scheduleVideoObservation(1000);
}

function schedulePoll() {
  stopPolling();
  syncVideo();
  // After video retries are exhausted, still frames keep simulator controls usable.
  if (session?.device.kind === "simulator" && videoFailures < 4) return;
  if (!canPoll()) return;
  // With a session, request the next frame as soon as the last one lands; back off after failures.
  const delay = !session ? 3000 : frameFailures ? Math.min(5000, 1000 * frameFailures) : 60;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void refreshLive();
  }, delay);
}

async function run(operation: () => Promise<void>, message?: string) {
  if (busy || ended) return false;
  busy = true;
  frameGeneration++;
  stopPolling();
  updateControls();
  if (message) showNotice(message);
  try {
    await operation();
    return true;
  } catch (error) {
    if (!ended) showNotice(errorMessage(error), true);
    return false;
  } finally {
    busy = false;
    updateControls();
    schedulePoll();
  }
}

function applyHub(next: HubState) {
  hub = next;
  const selected = session?.device.id ?? selectedDeviceId;
  if (session) {
    const retained = hub.sessions.find(item => item.id === session!.id);
    if (retained) selectSession(retained);
    else clearSession();
  }
  if (!session) {
    const matching = hub.sessions.filter(item => item.device.id === selected);
    const nextSession = matching.length === 1 ? matching[0] : hub.sessions.length === 1 ? hub.sessions[0] : undefined;
    if (nextSession) selectSession(nextSession);
  }
  selectedDeviceId = session?.device.id ?? (hub.devices.some(item => item.id === selected) ? selected : "");
  if (!selectedDeviceId) {
    const available = hub.devices.filter(item => item.available);
    if (available.length === 1) selectedDeviceId = available[0]!.id;
  }
  updateControls();
  if (!session) showNotice(hub.devices.some(item => item.available) ? "Ready to connect." : "Connect an Apple device or install a Simulator runtime to begin.");
  schedulePoll();
}

function selectSession(next: Session) {
  if (session?.id !== next.id) {
    h264Fallback = false;
    lifecycle++;
    stopVideo(true);
    resetStream();
    resetLiveInput();
    capture = undefined;
    screenImage = undefined;
    pointerStart = undefined;
    gestureMark.hidden = true;
    screen.removeAttribute("src");
    screenFrame.hidden = true;
    observedSettings = {};
  }
  session = next;
  selectedDeviceId = next.device.id;
  retiredSessionIds.delete(next.id);
  updateControls();
  schedulePoll();
}

function clearSession() {
  if (session) retiredSessionIds.add(session.id);
  lifecycle++;
  stopVideo(true);
  resetStream();
  resetLiveInput();
  stopPolling();
  session = undefined;
  capture = undefined;
  screenImage = undefined;
  observedSettings = {};
  pointerStart = undefined;
  gestureMark.hidden = true;
  screen.removeAttribute("src");
  screenFrame.hidden = true;
  publish({ videoMessage: "", videoError: false });
  schedulePoll();
}

function applyCapture(result: ToolResult, epoch = lifecycle) {
  if (ended || epoch !== lifecycle) return;
  const structured = result.structuredContent as unknown as CaptureState | undefined;
  const hierarchy = result._meta?.[HIERARCHY_META_KEY];
  const next = structured && typeof hierarchy === "string" ? { ...structured, hierarchy } : structured;
  const image = result.content.find(item => item.type === "image" && (item.mimeType === "image/png" || item.mimeType === "image/jpeg"));
  if (!next?.session || !next.coordinateSpace || !next.screenshot || !image || image.type !== "image") throw new Error("Device Hub returned an incomplete screen capture.");
  if (retiredSessionIds.has(next.session.id)) return;
  if (session && next.session.id !== session.id) return;
  if (!session) selectSession(sessionSchema.parse(next.session));
  session = next.session;
  // Live frames carry no hierarchy; keep the last observed tree until a full capture replaces it.
  capture = next.hierarchy === undefined && next.session.accessibilityEnabled && capture?.hierarchy !== undefined ? { ...next, hierarchy: capture.hierarchy } : next;
  if (next.settings) observedSettings = { ...observedSettings, ...next.settings };
  screenImage = { type: "image", data: image.data, mimeType: image.mimeType as ScreenImage["mimeType"] };
  screen.src = `data:${image.mimeType};base64,${image.data}`;
  screen.width = next.screenshot.width;
  screen.height = next.screenshot.height;
  screen.alt = `${next.session.device.name} screen captured ${new Date(next.capturedAt).toLocaleTimeString()}`;
  if (!canStreamVideo() || !videoPlayer) {
    videoCanvas.hidden = true;
    videoReady = false;
    videoDimensions = undefined;
  }
  screenFrame.hidden = false;
  showNotice(liveEnabled ? "Connected · Live" : `Connected · Updated ${new Date(next.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
  scheduleVideoObservation();
  updateControls();
}

async function captureCurrent(epoch = lifecycle, accessibilityEnabled?: boolean) {
  const current = session;
  const generation = frameGeneration;
  if (!current || epoch !== lifecycle || ended) return;
  const result = await callTool("device_capture", { sessionId: current.id, resolution: "full", ...(accessibilityEnabled === undefined ? {} : { accessibilityEnabled }) });
  if (generation !== frameGeneration) return;
  applyCapture(result, epoch);
}

async function refreshCapture() {
  if (!session) return;
  await run(() => captureCurrent(), "Refreshing screen…");
}

async function refreshLive() {
  if (!canPoll()) return;
  if (session?.device.kind === "simulator" && videoFailures < 4) { syncVideo(); return; }
  if (!session) {
    await run(async () => {
      const result = await callTool("device_hub_status", {});
      applyHub(result.structuredContent as unknown as HubState);
    });
    return;
  }
  await streamFrame(session);
}

/**
 * Fetches one live frame. Once the screen stops changing after a change, one
 * full capture refreshes the accessibility tree and observed settings.
 */
async function streamFrame(current: Session) {
  const epoch = lifecycle;
  const generation = frameGeneration;
  const settle = staleSince !== undefined && (lastFrameUnchanged || Date.now() - staleSince > 5000);
  streaming = true;
  try {
    const result = await callTool(settle ? "device_capture" : "device_frame", settle ? { sessionId: current.id, resolution: "full" } : { sessionId: current.id });
    const image = result.content.find(item => item.type === "image");
    if (image?.type === "image") {
      // Decode off-screen first so swapping the visible image never flashes.
      const decoder = new Image();
      decoder.src = `data:${image.mimeType};base64,${image.data}`;
      await decoder.decode().catch(() => {});
    }
    if (generation !== frameGeneration || epoch !== lifecycle || busy) return;
    applyCapture(result, epoch);
    frameFailures = 0;
    if (settle) { staleSince = undefined; lastFrameUnchanged = false; }
    else if (image?.type === "image") {
      lastFrameUnchanged = image.data === lastFrameData;
      if (lastFrameData !== undefined && !lastFrameUnchanged) staleSince ??= Date.now();
      lastFrameData = image.data;
    }
  } catch (error) {
    frameFailures++;
    if (!ended && session) showNotice(errorMessage(error), true);
  } finally {
    streaming = false;
    schedulePoll();
  }
}

export async function performAction(action: DeviceAction) {
  if (!session) return;
  // Xcode's Home takes seconds; the simulator's own button responds in one frame.
  if (action.type === "button" && action.button === "home" && liveInputReady()) {
    queueLiveInput({ type: "home", dt: elapsedInput(performance.now()) });
    scheduleVideoObservation(1000);
    return true;
  }
  const current = session;
  const epoch = lifecycle;
  return run(async () => {
    // The live stream shows animations, so the viewer skips the agent-oriented idle wait.
    const result = await callTool("device_action", { sessionId: current.id, action, settle: false, resolution: "full" });
    applyCapture(result, epoch);
  }, action.type === "openSettings" ? "Opening Settings…" : "Updating device…");
}

export async function changeSettings(settings: DeviceSettings) {
  if (!session) return;
  const current = session;
  const epoch = lifecycle;
  return run(async () => {
    const result = await callTool("device_settings", { sessionId: current.id, settings, resolution: "full" });
    applyCapture(result, epoch);
  }, "Applying device settings…");
}

function applyTheme(context: ReturnType<App["getHostContext"]>) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

function syncAttachment() {
  if (preview) return;
  const current = extensions.modelContext?.getCurrent();
  if (current === undefined) return;
  attachedAt = current && typeof current.structuredContent?.capturedAt === "string" ? current.structuredContent.capturedAt : undefined;
  publish({ attachmentStatus: current === null ? "Attach a screen to your next message." : attachmentLabel(), attached: current !== null });
}

function attachmentLabel() {
  return attachedAt ? `Screen from ${new Date(attachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} attached to your next message.` : "Screen attached to your next message.";
}

export async function attachScreen() {
  if (!session || !capture || !screenImage || !contextEnabled) return;
  const epoch = lifecycle;
  await run(async () => {
    // The decoded canvas is newer than the last observation; attachments need a fresh still.
    if (session?.device.kind === "simulator") await captureCurrent(epoch);
    if (epoch !== lifecycle || !capture || !screenImage || ended) return;
    const currentCapture = capture;
    const currentImage = screenImage;
    const payload: Parameters<App["updateModelContext"]>[0] = {
      content: [
        { type: "text", text: `${currentCapture.session.device.name} (${currentCapture.session.device.kind}) captured ${currentCapture.capturedAt}. Coordinate space: ${currentCapture.coordinateSpace.width} × ${currentCapture.coordinateSpace.height}.${currentCapture.hierarchy ? `\n\nAccessibility hierarchy:\n${currentCapture.hierarchy}` : ""}` },
        currentImage,
      ],
      structuredContent: { sessionId: currentCapture.session.id, deviceId: currentCapture.session.device.id, capturedAt: currentCapture.capturedAt, coordinateSpace: currentCapture.coordinateSpace },
    };
    const modelContext = extensions.modelContext;
    let attached = false;
    if (modelContext) attached = Boolean(await modelContext.update(payload));
    else await app.updateModelContext(payload);
    attachedAt = attached ? currentCapture.capturedAt : undefined;
    publish({ attachmentStatus: attached ? attachmentLabel() : "Screen sent. Host attachment status is unavailable.", attached });
    showNotice("Current screen sent to conversation context.");
  }, "Attaching current screen…");
}

function receiveResult(result: ToolResult) {
  if (ended) return;
  if (result.isError) {
    if (result._meta?.errorCode === "SESSION_EXPIRED" && result._meta.sessionId === session?.id) clearSession();
    showNotice(resultError(result), true);
    return;
  }
  const value = result.structuredContent;
  if (value && Array.isArray(value.devices) && Array.isArray(value.sessions) && Array.isArray(value.warnings)) {
    applyHub(value as unknown as HubState);
    if (initialized && session && !capture) void refreshCapture();
  } else if (value?.session && value?.screenshot) {
    try { applyCapture(result); } catch (error) { showNotice(errorMessage(error), true); }
  } else if (value?.disconnected === true && value.sessionId === session?.id) {
    clearSession();
    showNotice("Disconnected. The device remains available.");
  } else {
    const connected = sessionSchema.safeParse(value);
    if (connected.success) {
      selectSession(connected.data);
      if (initialized) void refreshCapture();
    }
  }
  schedulePoll();
}

export function selectDevice(id: string) { selectedDeviceId = id; publish(); }

export async function toggleConnection() {
  await run(async () => {
    if (session) {
      const current = session;
      disconnecting = true;
      stopVideo();
      try {
        await callTool("device_disconnect", { sessionId: current.id });
        clearSession();
        hub = { ...hub, sessions: hub.sessions.filter(item => item.id !== current.id) };
        showNotice("Disconnected. The device remains available.");
      } finally { disconnecting = false; }
    } else {
      const result = await callTool("device_connect", { deviceId: selectedDeviceId });
      if (ended) return;
      selectSession(sessionSchema.parse(result.structuredContent));
      await captureCurrent();
    }
  }, session ? "Disconnecting device…" : "Connecting device…");
}

export async function scanDevices() {
  await run(async () => {
    const result = await callTool("device_hub_status", {});
    applyHub(result.structuredContent as unknown as HubState);
    if (session && !capture) await captureCurrent();
    else if (session) showNotice("Device list refreshed.");
  }, "Finding devices…");
}

export function setLive(value: boolean) {
  liveEnabled = value;
  videoFailures = 0;
  if (session && capture) showNotice(value ? "Connected · Live" : "Connected · Paused");
  publish();
  schedulePoll();
}

export function retryVideo() { stopVideo(); videoFailures = 0; h264Fallback = false; liveInputError = undefined; schedulePoll(); }

export async function setAccessibility(requested: boolean) {
  const epoch = lifecycle;
  await run(() => captureCurrent(epoch, requested), requested ? "Reading accessibility tree…" : "Disabling accessibility tree…");
}

export function setInspectorMode(value: boolean, onPick?: typeof pickElement) {
  inspecting = value;
  pickElement = onPick;
}

export function setSettingsOpen(value: boolean) { settingsOpen = value; schedulePoll(); }

export function rotateDevice() {
  const landscape = capture?.deviceOrientation && capture.deviceOrientation !== "Unknown"
    ? /^landscape/i.test(capture.deviceOrientation)
    : Boolean(capture && capture.coordinateSpace.width > capture.coordinateSpace.height);
  void performAction({ type: "orientation", orientation: landscape ? "portrait" : "landscapeLeft" });
}

export { refreshCapture };

function devicePoint(event: PointerEvent) {
  const rect = (videoCanvas.hidden ? screen : videoCanvas).getBoundingClientRect();
  if (!capture || !rect.width || !rect.height) return undefined;
  if (!videoCanvas.hidden && videoDimensions && !coordinateSpaceMatchesFrame(capture.coordinateSpace, videoDimensions)) {
    refreshVideoCoordinates();
    return undefined;
  }
  return screenToDevicePoint({ x: event.clientX, y: event.clientY }, rect, capture.coordinateSpace);
}

function bindScreen() {
screenFrame.addEventListener("pointerdown", event => {
  if (!session || ended || event.button !== 0 || liveTouch) return;
  if (!inspecting && liveInputReady()) {
    const point = framePoint(event);
    if (!point) return;
    event.preventDefault();
    liveTouch = { id: event.pointerId, epoch: lifecycle, point };
    screenFrame.setPointerCapture(event.pointerId);
    placeGestureMark(event);
    queueLiveInput({ type: "down", ...point, dt: elapsedInput(eventTime(event)) });
    return;
  }
  if (busy) return;
  const point = devicePoint(event);
  if (!point) return;
  event.preventDefault();
  stopPolling();
  pointerStart = { ...point, id: event.pointerId, clientX: event.clientX, clientY: event.clientY, time: performance.now(), epoch: lifecycle, width: capture!.coordinateSpace.width, height: capture!.coordinateSpace.height };
  screenFrame.setPointerCapture(event.pointerId);
  placeGestureMark(event);
});
screenFrame.addEventListener("pointermove", event => {
  if (liveTouch?.id !== event.pointerId) return;
  const point = framePoint(event);
  if (!point) return;
  liveTouch.point = point;
  placeGestureMark(event);
  if (liveTouch.epoch === lifecycle) queueLiveInput({ type: "move", ...point, dt: elapsedInput(eventTime(event)) });
});
screenFrame.addEventListener("pointerup", event => {
  if (liveTouch?.id === event.pointerId) { finishLiveTouch(event, "up"); return; }
  const start = pointerStart;
  pointerStart = undefined;
  gestureMark.hidden = true;
  if (screenFrame.hasPointerCapture(event.pointerId)) screenFrame.releasePointerCapture(event.pointerId);
  const end = devicePoint(event);
  if (!start || start.id !== event.pointerId || start.epoch !== lifecycle || !end || start.width !== capture?.coordinateSpace.width || start.height !== capture.coordinateSpace.height) { schedulePoll(); return; }
  const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
  if (inspecting) { if (distance < 8) pickElement?.(end); schedulePoll(); return; }
  if (distance < 8) void performAction({ type: "tap", x: start.x, y: start.y });
  else void performAction({ type: "swipe", x: start.x, y: start.y, toX: end.x, toY: end.y, duration: Math.max(0.1, Math.min(5, (performance.now() - start.time) / 1000)) });
});
screenFrame.addEventListener("pointercancel", event => {
  if (liveTouch?.id === event.pointerId) { finishLiveTouch(event, "cancel"); return; }
  pointerStart = undefined;
  gestureMark.hidden = true;
  schedulePoll();
});
screenFrame.addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("visibilitychange", schedulePoll);
}

let observer: IntersectionObserver;
function endView() {
  ended = true;
  lifecycle++;
  stopPolling();
  stopVideo();
  observer?.disconnect();
  updateControls();
}
app.onteardown = async () => { endView(); return {}; };
app.addEventListener("toolresult", receiveResult);
app.addEventListener("toolcancelled", ({ reason }) => showNotice(reason ?? "Device action cancelled.", true));
app.addEventListener("hostcontextchanged", context => {
  applyTheme(context);
  if (Object.hasOwn(context, OPENAI_MODEL_CONTEXT_KEY)) syncAttachment();
});
app.onerror = error => { if (!ended) showNotice(errorMessage(error), true); };

export async function initializeViewer(nodes: { root: HTMLElement; screen: HTMLImageElement; canvas: HTMLCanvasElement; frame: HTMLElement; gesture: HTMLElement }) {
  root = nodes.root; screen = nodes.screen; videoCanvas = nodes.canvas; screenFrame = nodes.frame; gestureMark = nodes.gesture;
  bindScreen();
  observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); schedulePoll(); });
  observer.observe(root);
  window.addEventListener("pagehide", endView);
  window.addEventListener("beforeunload", endView);
  try {
    if (preview) {
      applyDocumentTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      publish({ attachmentStatus: "Screen attachment is available inside ChatGPT." });
      initialized = true;
      await run(async () => { receiveResult(await callTool("device_hub_status", {})); });
    } else {
      await app.connect();
      initialized = true;
      applyTheme(app.getHostContext());
      contextEnabled = Boolean(app.getHostCapabilities()?.updateModelContext?.image);
      if (!contextEnabled) publish({ attachmentStatus: "This host does not support screen attachments." });
      syncAttachment();
    }
    updateControls();
    if (session && !capture) await refreshCapture();
    else schedulePoll();
  } catch (error) {
    showNotice(errorMessage(error), true);
    updateControls();
  }
}
