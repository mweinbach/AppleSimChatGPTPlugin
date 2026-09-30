import { memo, useEffect, useRef } from "react";
import { Crosshair, Home, LoaderCircle, LockKeyhole, RefreshCw, RotateCw, Smartphone } from "lucide-react";
import { Button } from "./ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.js";
import { Switch } from "./ui/switch.js";
import { Toggle } from "./ui/toggle.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";
import { initializeViewer, performAction, refreshCapture, retryVideo, rotateDevice, setLive, type ViewerState } from "../viewer-controller.js";
import { screenElementRect } from "../screen-mapping.js";
import type { ScreenElement } from "../elements.js";

// The decoder owns image/canvas pixels; React owns chrome and the element overlay.
const ScreenSurface = memo(function ScreenSurface({ state, highlight, inspecting, mappingReady }: { state: ViewerState; highlight?: ScreenElement; inspecting: boolean; mappingReady: boolean }) {
  const screen = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const gesture = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    void initializeViewer({ root: document.getElementById("root")!, screen: screen.current!, canvas: canvas.current!, frame: frame.current!, gesture: gesture.current! });
  }, []);
  const bounds = state.capture?.coordinateSpace;
  const rect = highlight && bounds && mappingReady ? screenElementRect(highlight.frame, bounds) : undefined;
  return <div id="screen-frame" className="screen-frame" data-inspecting={inspecting} data-busy={state.busy} ref={frame} hidden>
    <img id="screen" ref={screen} alt="Connected Apple device screen" draggable={false} />
    <canvas id="screen-video" ref={canvas} aria-label="Live simulator screen" hidden />
    {rect && <div className="element-highlight" data-testid="element-highlight" style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }} aria-hidden="true" />}
    <span id="gesture-mark" className="gesture-mark" ref={gesture} hidden />
  </div>;
});

export function ScreenViewer({ state, highlight, inspecting, onInspect, mappingReady }: { state: ViewerState; highlight?: ScreenElement; inspecting: boolean; onInspect: (value: boolean) => void; mappingReady: boolean }) {
  const disabled = !state.session || state.busy || state.ended;
  const showScreen = Boolean(state.capture || state.videoReady);
  return <section className="viewer-panel" aria-label="Device screen">
    <div className="viewer-heading">
      <div className="section-title"><Smartphone /><h2>Device screen</h2></div>
      <div className="screen-options">
        <label className="live-control" htmlFor="live"><Switch id="live" checked={state.liveEnabled} disabled={!state.initialized || state.ended} onCheckedChange={setLive} />Live</label>
        <Tooltip><TooltipTrigger asChild><Toggle id="inspect" variant="outline" size="sm" pressed={inspecting} disabled={disabled || !mappingReady} onPressedChange={onInspect} aria-label="Inspect screen elements"><Crosshair data-icon="inline-start" />Inspect</Toggle></TooltipTrigger><TooltipContent>Click the screen to select an element</TooltipContent></Tooltip>
      </div>
    </div>
    <div className="simulator-stage" id="viewport">
      {!showScreen && <Empty className="screen-empty"><EmptyHeader><EmptyMedia variant="icon">{state.session ? <LoaderCircle className="animate-spin" /> : <Smartphone />}</EmptyMedia><EmptyTitle>{state.session ? "Opening device…" : "Choose a device"}</EmptyTitle><EmptyDescription>{state.session ? "The first screen will appear here." : "Connect to view its screen and control it here."}</EmptyDescription></EmptyHeader></Empty>}
      <ScreenSurface state={state} highlight={highlight} inspecting={inspecting} mappingReady={mappingReady} />
    </div>
    <div className="screen-caption"><span id="gesture-help">{!mappingReady && showScreen ? "Updating screen orientation…" : inspecting ? "Click an element on the screen to inspect it" : "Click to tap · drag to swipe"}</span><span className="screen-metadata"><span id="screen-dimensions">{state.capture && `${state.capture.coordinateSpace.width} × ${state.capture.coordinateSpace.height} pt`}</span>{!state.videoError && state.session?.device.kind === "simulator" && <span id="video-status" role="status">{state.videoMessage}</span>}</span></div>
    {state.videoError && <div id="video-status-row" className="video-status-row" data-error><span role="status">{state.videoMessage}</span><Button id="retry-video" variant="link" size="xs" onClick={retryVideo}>Retry video</Button></div>}
    <div className="device-toolbar" aria-label="Device controls">
      <Button id="home" variant="ghost" disabled={disabled} onClick={() => void performAction({ type: "button", button: "home" })}><Home data-icon="inline-start" /><span>Home</span></Button>
      <Button id="lock" variant="ghost" disabled={disabled} onClick={() => void performAction({ type: "button", button: "lock" })}><LockKeyhole data-icon="inline-start" /><span>Lock</span></Button>
      <Button id="rotate" variant="ghost" disabled={disabled} onClick={rotateDevice}><RotateCw data-icon="inline-start" /><span>Rotate</span></Button>
      <Button id="capture" variant="ghost" disabled={disabled} onClick={() => void refreshCapture()}><RefreshCw data-icon="inline-start" /><span>Refresh</span></Button>
    </div>
  </section>;
}
