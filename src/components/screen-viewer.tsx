import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { House, ImagePlus, Keyboard, ListTree, LoaderCircle, LockKeyhole, Pause, Play, RotateCw, ScanEye, Send, SlidersHorizontal, X } from "lucide-react";
import { Button } from "./ui/button.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";
import { DeviceChooser, deviceForm } from "./device-picker.js";
import { attachScreen, initializeViewer, performAction, retryVideo, rotateDevice, setLive, type ViewerState } from "../viewer-controller.js";
import { elementAtPoint, screenElementRect } from "../screen-mapping.js";
import type { ScreenElement } from "../elements.js";
import type { DeviceActivity } from "../shared.js";

export type Panel = "elements" | "appearance";

const percent = (value: number, total: number) => `${value / total * 100}%`;

function ActivityMark({ activity, bounds }: { activity: DeviceActivity; bounds: { width: number; height: number } }) {
  if (!activity.point) return null;
  if (activity.to) {
    return <svg className="activity-swipe" viewBox={`0 0 ${bounds.width} ${bounds.height}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1={activity.point.x} y1={activity.point.y} x2={activity.to.x} y2={activity.to.y} />
      <circle cx={activity.to.x} cy={activity.to.y} r={bounds.width / 40} />
    </svg>;
  }
  return <span className="activity-tap" style={{ left: percent(activity.point.x, bounds.width), top: percent(activity.point.y, bounds.height) }} aria-hidden="true" />;
}

// The decoder owns image/canvas pixels; React owns the overlays.
const ScreenSurface = memo(function ScreenSurface({ state, elements, highlight, agentView, inspecting, mappingReady, onHover }: {
  state: ViewerState; elements: ScreenElement[]; highlight?: ScreenElement; agentView: boolean; inspecting: boolean; mappingReady: boolean; onHover: (element?: ScreenElement) => void;
}) {
  const screen = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const gesture = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    void initializeViewer({ root: document.getElementById("root")!, screen: screen.current!, canvas: canvas.current!, frame: frame.current!, gesture: gesture.current! });
  }, []);
  const bounds = state.capture?.coordinateSpace;
  const shape = state.videoDimensions ?? bounds;
  const rect = highlight && bounds && mappingReady ? screenElementRect(highlight.frame, bounds) : undefined;
  const hover = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!agentView || !bounds || !mappingReady || event.pointerType !== "mouse" || event.buttons) return;
    const area = event.currentTarget.getBoundingClientRect();
    onHover(elementAtPoint(elements, { x: (event.clientX - area.left) / area.width * bounds.width, y: (event.clientY - area.top) / area.height * bounds.height }));
  };
  return <div id="screen-frame" className="screen-frame" data-form={deviceForm(state.session?.device)} data-orientation={shape && shape.width > shape.height ? "landscape" : "portrait"} data-inspecting={inspecting} data-busy={state.busy && !state.liveInput} ref={frame} hidden onPointerMove={hover} onPointerLeave={() => { if (agentView) onHover(undefined); }}>
    <img id="screen" ref={screen} alt="Connected Apple device screen" draggable={false} />
    <canvas id="screen-video" ref={canvas} aria-label="Live device screen" hidden />
    {agentView && bounds && mappingReady && <div className="agent-view" aria-hidden="true">
      {elements.map(element => {
        const box = screenElementRect(element.frame, bounds);
        return box && <span key={element.ref} className="agent-box" style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` }}><span className="agent-ref">{element.ref}</span></span>;
      })}
    </div>}
    {rect && <div className="element-highlight" data-testid="element-highlight" style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }} aria-hidden="true" />}
    {state.activity && bounds && mappingReady && <ActivityMark key={state.activity.id} activity={state.activity} bounds={bounds} />}
    <span id="gesture-mark" className="gesture-mark" ref={gesture} hidden />
  </div>;
});

function DockButton({ label, pressed, disabled, onClick, children, id }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; id?: string }) {
  return <Tooltip><TooltipTrigger asChild>
    <Button id={id} variant="ghost" size="icon" className="dock-button" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</Button>
  </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

function TypeBar({ state, onClose }: { state: ViewerState; onClose: () => void }) {
  const [text, setText] = useState("");
  const disabled = !state.session || state.busy || state.ended;
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!text || disabled) return;
    const submitted = text;
    if (await performAction({ type: "type", text: submitted })) setText(current => current === submitted ? "" : current);
  }
  return <form className="type-bar" onSubmit={event => void send(event)} onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <InputGroup>
      <InputGroupAddon><Keyboard /></InputGroupAddon>
      <InputGroupInput id="type-text" autoFocus placeholder={`Type on ${state.session?.device.name ?? "the device"}…`} aria-label="Text to type on the device" value={text} disabled={disabled} autoComplete="off" maxLength={10000} onChange={event => setText(event.target.value)} />
    </InputGroup>
    <Button type="submit" size="sm" disabled={disabled || !text}><Send data-icon="inline-start" />Send</Button>
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Close keyboard" onClick={onClose}><X /></Button>
  </form>;
}

function StatusLine({ state, hovered }: { state: ViewerState; hovered?: ScreenElement }) {
  const simulator = state.session?.device.kind === "simulator";
  let status: React.ReactNode;
  if (hovered) status = <span className="status-element"><span className="ref-badge">{hovered.ref}</span>{hovered.role}{hovered.label ? ` “${hovered.label}”` : ""}</span>;
  else if (state.busy) status = <><LoaderCircle className="animate-spin" aria-hidden="true" />{state.notice}</>;
  else if (state.videoError) status = <span className="status-error">{state.videoMessage} <Button variant="link" size="xs" className="status-action" onClick={retryVideo}>Retry</Button></span>;
  else if (state.noticeError) status = <span className="status-error">{state.notice}</span>;
  else if (!state.liveEnabled) status = <><span className="status-dot" aria-hidden="true" />Paused</>;
  else if (simulator && !state.videoReady) status = <><LoaderCircle className="animate-spin" aria-hidden="true" />{state.videoMessage || "Starting live video…"}</>;
  else status = <><span className="status-dot" data-state="live" aria-hidden="true" />{simulator ? "Live" : state.capture ? `Updated ${new Date(state.capture.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "Connecting…"}</>;
  // A still screen sends no frames, so the rate only means something while it changes.
  const rate = state.videoReady && state.videoFps ? `${state.videoFps} fps` : undefined;
  return <div className="status-line">
    <span id="video-status" className="status-text" role="status">{status}</span>
    <span className="status-end">
      {rate && <span className="status-rate" title={state.videoCodec ? `${state.videoCodec} video` : undefined}>{rate}</span>}
      <Tooltip><TooltipTrigger asChild><Button id="live" variant="ghost" size="icon-xs" aria-label={state.liveEnabled ? "Pause live screen" : "Resume live screen"} disabled={!state.initialized || state.ended} onClick={() => setLive(!state.liveEnabled)}>{state.liveEnabled ? <Pause /> : <Play />}</Button></TooltipTrigger><TooltipContent>{state.liveEnabled ? "Pause live screen" : "Resume live screen"}</TooltipContent></Tooltip>
    </span>
  </div>;
}

export function ScreenViewer({ state, elements, highlight, hovered, agentView, inspecting, mappingReady, panel, onHover, onAgentView, onPanel }: {
  state: ViewerState; elements: ScreenElement[]; highlight?: ScreenElement; hovered?: ScreenElement; agentView: boolean; inspecting: boolean; mappingReady: boolean; panel?: Panel;
  onHover: (element?: ScreenElement) => void; onAgentView: (value: boolean) => void; onPanel: (panel?: Panel) => void;
}) {
  const [typing, setTyping] = useState(false);
  const connected = Boolean(state.session);
  const disabled = !connected || state.busy || state.ended;
  const showScreen = Boolean(state.capture || state.videoReady);
  useEffect(() => { if (!connected) setTyping(false); }, [connected]);
  return <section className="viewer" aria-label="Device screen">
    <div className="stage" id="viewport" data-mode={connected ? "device" : "choose"}>
      {!connected && <DeviceChooser state={state} />}
      {connected && !showScreen && <div className="screen-placeholder" data-form={deviceForm(state.session?.device)} aria-label={state.notice}><LoaderCircle className="animate-spin" aria-hidden="true" /><span>{state.notice}</span></div>}
      <ScreenSurface state={state} elements={elements} highlight={highlight} agentView={agentView} inspecting={inspecting} mappingReady={mappingReady} onHover={onHover} />
      {state.activity && connected && <p key={state.activity.id} className="activity-caption" role="status">{state.activity.ref && <span className="ref-badge">{state.activity.ref}</span>}{state.activity.summary}</p>}
    </div>
    {connected && <>
      <StatusLine state={state} hovered={agentView ? hovered : undefined} />
      {typing && <TypeBar state={state} onClose={() => setTyping(false)} />}
      <nav className="dock" aria-label="Device controls">
        <div className="dock-group">
          <DockButton id="home" label="Home" disabled={state.ended || (!state.liveInput && disabled)} onClick={() => void performAction({ type: "button", button: "home" })}><House /></DockButton>
          <DockButton id="lock" label="Lock" disabled={disabled} onClick={() => void performAction({ type: "button", button: "lock" })}><LockKeyhole /></DockButton>
          <DockButton id="rotate" label="Rotate" disabled={disabled} onClick={rotateDevice}><RotateCw /></DockButton>
          <DockButton id="keyboard" label="Type text" pressed={typing} disabled={disabled && !typing} onClick={() => setTyping(value => !value)}><Keyboard /></DockButton>
        </div>
        <div className="dock-group">
          <DockButton id="agent-view" label={agentView ? "Hide what the agent sees" : "Show what the agent sees"} pressed={agentView} disabled={!connected || state.ended} onClick={() => onAgentView(!agentView)}><ScanEye /></DockButton>
          <DockButton id="show-elements" label="Elements" pressed={panel === "elements"} disabled={!connected} onClick={() => onPanel(panel === "elements" ? undefined : "elements")}><ListTree /></DockButton>
          <DockButton id="show-appearance" label="Appearance and accessibility settings" pressed={panel === "appearance"} disabled={!connected} onClick={() => onPanel(panel === "appearance" ? undefined : "appearance")}><SlidersHorizontal /></DockButton>
          <DockButton id="attach" label={state.attached ? state.attachmentStatus : state.contextEnabled ? "Attach screen to your next message" : state.attachmentStatus} pressed={state.attached} disabled={disabled || !state.capture || !state.contextEnabled} onClick={() => void attachScreen()}><ImagePlus /></DockButton>
        </div>
      </nav>
    </>}
  </section>;
}
