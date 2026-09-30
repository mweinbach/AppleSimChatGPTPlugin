import { RefreshCw, Smartphone, Tablet, LoaderCircle } from "lucide-react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Field, FieldLabel } from "./ui/field.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";
import { scanDevices, selectDevice, setSettingsOpen, toggleConnection, type ViewerState } from "../viewer-controller.js";

export function DevicePicker({ state }: { state: ViewerState }) {
  const device = state.session?.device ?? state.hub.devices.find(item => item.id === state.selectedDeviceId);
  const available = state.hub.devices.filter(item => item.available).sort((left, right) => Number(right.state.toLowerCase() === "booted") - Number(left.state.toLowerCase() === "booted") || left.name.localeCompare(right.name));
  // Retain the active device if it disappears from a discovery refresh.
  if (state.session && !available.some(item => item.id === device?.id)) available.unshift(state.session.device);
  const groups = [
    { label: "Simulators", devices: available.filter(item => item.kind === "simulator") },
    { label: "Connected devices", devices: available.filter(item => item.kind === "device") },
  ];
  const disabled = !state.initialized || state.busy || state.ended;
  const loading = !state.initialized || (state.busy && !state.hub.devices.length);
  const DeviceIcon = device?.name.startsWith("iPad") ? Tablet : Smartphone;

  return <section className="connection-bar" aria-label="Device connection">
    <DeviceIcon className="connection-device-icon" aria-hidden="true" />
    <Field className="device-field">
      <FieldLabel htmlFor="devices" className="sr-only">Device</FieldLabel>
      <Select value={state.selectedDeviceId} onValueChange={selectDevice} disabled={disabled || Boolean(state.session)} onOpenChange={setSettingsOpen}>
        <SelectTrigger id="devices" className="w-full"><SelectValue placeholder={loading ? "Loading devices…" : available.length ? "Choose a device…" : "No devices available"}>{device?.name}</SelectValue></SelectTrigger>
        <SelectContent position="popper" align="start">
          {groups.filter(group => group.devices.length).map(group => <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.devices.map(item => <SelectItem key={item.id} value={item.id}>{item.name}<span className="device-option-meta">{item.runtime || item.platform}{item.state.toLowerCase() === "booted" ? " · Running" : ""}</span></SelectItem>)}
          </SelectGroup>)}
        </SelectContent>
      </Select>
    </Field>
    {device && <span id="device-details" className="device-runtime">{device.runtime || device.platform}<span className="device-kind">{device.kind === "simulator" ? "Simulator" : "Physical device"}</span></span>}
    <div className="connection-actions">
      <Badge variant={state.session ? "secondary" : "outline"} className="connection-badge"><span className="status-dot" data-connected={Boolean(state.session)} />{state.session ? "Connected" : "Disconnected"}</Badge>
      <Tooltip><TooltipTrigger asChild><Button id="scan" variant="ghost" size="icon" disabled={disabled} onClick={() => void scanDevices()} aria-label="Refresh device list"><RefreshCw /></Button></TooltipTrigger><TooltipContent>Refresh device list</TooltipContent></Tooltip>
      <Button id="connection" variant={state.session ? "outline" : "default"} disabled={disabled || (!state.session && !state.selectedDeviceId)} onClick={() => void toggleConnection()}>
        {state.busy && !state.capture && <LoaderCircle className="animate-spin" data-icon="inline-start" />}{state.session ? "Disconnect" : "Connect"}
      </Button>
    </div>
  </section>;
}
