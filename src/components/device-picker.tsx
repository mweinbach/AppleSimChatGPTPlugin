import { useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, Smartphone, Tablet, TriangleAlert, Watch } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.js";
import { Button } from "./ui/button.js";
import type { Device } from "../shared.js";
import { connectDevice, type ViewerState } from "../viewer-controller.js";

export function deviceForm(device?: Pick<Device, "name">): "phone" | "tablet" | "watch" {
  if (!device) return "phone";
  if (/\biPad\b/i.test(device.name)) return "tablet";
  if (/\bWatch\b/i.test(device.name)) return "watch";
  return "phone";
}

export function DeviceIcon({ device }: { device?: Pick<Device, "name"> }) {
  const form = deviceForm(device);
  return form === "tablet" ? <Tablet /> : form === "watch" ? <Watch /> : <Smartphone />;
}

const running = (device: Device) => device.state.toLowerCase() === (device.kind === "simulator" ? "booted" : "connected");
const formOrder = { phone: 0, tablet: 1, watch: 2 };
const version = (device: Device) => (device.runtime.match(/[\d.]+$/)?.[0] ?? "0").split(".").map(Number);
/** iPhones first, then iPads and watches; newest runtime first within each. */
function compareSimulators(left: Device, right: Device) {
  const form = formOrder[deviceForm(left)] - formOrder[deviceForm(right)];
  if (form) return form;
  const [a, b] = [version(left), version(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
  return left.name.localeCompare(right.name);
}

function DeviceRow({ device, state }: { device: Device; state: ViewerState }) {
  const connecting = state.busy && state.selectedDeviceId === device.id;
  const status = !device.available ? "Unavailable" : running(device) ? "Running" : device.kind === "simulator" ? "Starts when connected" : "Not connected";
  return <li>
    <button type="button" className="device-row" data-running={running(device)} disabled={!device.available || state.busy || !state.initialized} aria-busy={connecting} onClick={() => void connectDevice(device.id)}>
      <span className="device-row-icon" aria-hidden="true"><DeviceIcon device={device} /></span>
      <span className="device-row-copy">
        <span className="device-row-name">{device.name}</span>
        <span className="device-row-meta">{device.runtime || device.platform}<span aria-hidden="true"> · </span>{running(device) && <span className="status-dot" data-state="live" aria-hidden="true" />}{status}</span>
      </span>
      <span className="device-row-action">{connecting ? <><LoaderCircle className="animate-spin" aria-hidden="true" />{device.kind === "simulator" && !running(device) ? "Starting…" : "Connecting…"}</> : <>Connect<ChevronRight aria-hidden="true" /></>}</span>
    </button>
  </li>;
}

/** Shown in place of the screen until a device is connected. */
export function DeviceChooser({ state }: { state: ViewerState }) {
  const [showAll, setShowAll] = useState(false);
  const devices = [...state.hub.devices].sort((left, right) => Number(running(right)) - Number(running(left)) || compareSimulators(left, right));
  const active = devices.filter(device => running(device) && device.available);
  const simulators = devices.filter(device => device.kind === "simulator" && !active.includes(device));
  const physical = devices.filter(device => device.kind === "device" && !active.includes(device));
  const shown = showAll ? simulators : simulators.filter(device => device.available).slice(0, active.length ? 4 : 8);
  const loading = !state.initialized || (state.busy && !state.hub.devices.length);
  return <div className="chooser" aria-busy={loading}>
    {state.noticeError && <Alert variant="destructive"><TriangleAlert /><AlertTitle>Could not connect</AlertTitle><AlertDescription>{state.notice}</AlertDescription></Alert>}
    {state.hub.warnings.length > 0 && <Alert><TriangleAlert /><AlertTitle>Some devices could not be listed</AlertTitle><AlertDescription>{state.hub.warnings.map(warning => <p key={warning}>{warning}</p>)}</AlertDescription></Alert>}
    {loading ? <ul className="device-list" aria-label="Loading devices">{[0, 1, 2].map(index => <li key={index} className="device-row-skeleton" />)}</ul> : <>
      {active.length > 0 && <section className="device-group" aria-labelledby="running-heading"><h2 id="running-heading">Running</h2><ul className="device-list">{active.map(device => <DeviceRow key={device.id} device={device} state={state} />)}</ul></section>}
      {simulators.length > 0 && <section className="device-group" aria-labelledby="simulators-heading">
        <h2 id="simulators-heading">{active.length ? "Other simulators" : "Simulators"}</h2>
        <ul className="device-list">{shown.map(device => <DeviceRow key={device.id} device={device} state={state} />)}</ul>
        {shown.length < simulators.length && <Button variant="ghost" size="sm" className="device-more" onClick={() => setShowAll(true)}>Show all {simulators.length}<ChevronDown data-icon="inline-end" /></Button>}
      </section>}
      {physical.length > 0 && <section className="device-group" aria-labelledby="physical-heading"><h2 id="physical-heading">Physical devices</h2><ul className="device-list">{physical.map(device => <DeviceRow key={device.id} device={device} state={state} />)}</ul></section>}
      {!devices.length && <p className="chooser-empty">No simulators or devices found. Install a simulator runtime in Xcode, or connect and unlock a paired device, then refresh.</p>}
    </>}
    <p className="chooser-note">Device Hub uses Xcode on this Mac. Keep Xcode open with <strong>Settings → Intelligence → Model Context Protocol</strong> turned on.</p>
  </div>;
}
