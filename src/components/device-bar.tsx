import type { ReactNode } from "react";
import { LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { Button } from "./ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";
import { DeviceIcon } from "./device-picker.js";
import { scanDevices, setLive, toggleConnection, type ViewerState } from "../viewer-controller.js";

function LiveStatus({ state }: { state: ViewerState }) {
  const simulator = state.session?.device.kind === "simulator";
  if (state.busy) return <><LoaderCircle className="animate-spin" aria-hidden="true" />{state.notice}</>;
  if (!state.liveEnabled) return <><span className="status-dot" aria-hidden="true" />Paused</>;
  if (simulator && !state.videoReady) {
    return state.videoError
      ? <><span className="status-dot" data-state="error" aria-hidden="true" />Live video unavailable</>
      : <><LoaderCircle className="animate-spin" aria-hidden="true" />{state.videoMessage || "Starting live video…"}</>;
  }
  if (!simulator) {
    return <><span className="status-dot" data-state="live" aria-hidden="true" />{state.capture ? `Updated ${new Date(state.capture.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "Connecting…"}</>;
  }
  // A still screen sends no frames, so the rate only means something while it changes.
  return <><span className="status-dot" data-state="live" aria-hidden="true" />Live{Boolean(state.videoFps) && <span className="status-rate" title={state.videoCodec ? `${state.videoCodec} video` : undefined}>{state.videoFps} fps</span>}</>;
}

/** Device identity and live status; wide layouts also carry the device controls here. */
export function DeviceBar({ state, controls }: { state: ViewerState; controls?: ReactNode }) {
  const device = state.session?.device;
  const disabled = !state.initialized || state.busy || state.ended;
  if (!device) {
    return <header className="device-bar">
      <h1 className="device-bar-title">Choose a device</h1>
      <Tooltip><TooltipTrigger asChild><Button id="scan" variant="ghost" size="icon-sm" className="device-bar-end" disabled={disabled} onClick={() => void scanDevices()} aria-label="Refresh device list"><RefreshCw /></Button></TooltipTrigger><TooltipContent>Refresh device list</TooltipContent></Tooltip>
    </header>;
  }
  const pauseLabel = state.liveEnabled ? "Pause live screen" : "Resume live screen";
  return <header className="device-bar">
    <span className="device-bar-icon" aria-hidden="true"><DeviceIcon device={device} /></span>
    <div className="device-identity">
      <h1 className="device-name" title={device.name}>{device.name}</h1>
      <p className="device-meta">
        <span className="device-runtime">{device.runtime || device.platform}{device.kind === "simulator" ? " Simulator" : ""}</span>
        <span aria-hidden="true">·</span>
        <span id="video-status" className="device-status" role="status"><LiveStatus state={state} /></span>
        <Tooltip><TooltipTrigger asChild><Button id="live" variant="ghost" size="icon-xs" className="device-pause" aria-label={pauseLabel} disabled={!state.initialized || state.ended} onClick={() => setLive(!state.liveEnabled)}>{state.liveEnabled ? <Pause /> : <Play />}</Button></TooltipTrigger><TooltipContent>{pauseLabel}</TooltipContent></Tooltip>
      </p>
    </div>
    {controls && <div className="device-bar-controls">{controls}</div>}
    <Button id="connection" variant="ghost" size="sm" className="device-bar-end" disabled={disabled} onClick={() => void toggleConnection()}>Disconnect</Button>
  </header>;
}
