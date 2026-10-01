import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { Button } from "./ui/button.js";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "./ui/field.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";
import { Switch } from "./ui/switch.js";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.js";
import { textSizeSchema } from "../shared.js";
import { changeSettings, performAction, setSettingsOpen, type ViewerState } from "../viewer-controller.js";

const preferences = [
  { key: "reduceMotion", id: "reduce-motion", label: "Reduce Motion" },
  { key: "reduceTransparency", id: "reduce-transparency", label: "Reduce Transparency" },
  { key: "increasedContrast", id: "increased-contrast", label: "Increase Contrast" },
] as const;
const textSizeLabel = (value: string) => value.replace(/^accessibility-/, "Accessibility ").replaceAll("-", " ").replace(/^./, letter => letter.toUpperCase());

export function DeviceSettings({ state }: { state: ViewerState }) {
  const disabled = !state.session || state.busy || state.ended;
  return <div className="settings-pane">
    <FieldGroup>
      <Field orientation="horizontal" data-disabled={disabled}>
        <FieldContent><FieldLabel>Appearance</FieldLabel></FieldContent>
        <ToggleGroup type="single" variant="outline" spacing={0} size="sm" value={state.settings.appearance ?? ""} disabled={disabled} onValueChange={value => { if (value === "light" || value === "dark") void changeSettings({ appearance: value }); }} aria-label="Device appearance">
          <ToggleGroupItem value="light" id="appearance-light" aria-label="Light appearance"><Sun data-icon="inline-start" />Light</ToggleGroupItem>
          <ToggleGroupItem value="dark" id="appearance-dark" aria-label="Dark appearance"><Moon data-icon="inline-start" />Dark</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="text-size">Text size</FieldLabel>
        <Select value={state.settings.textSize ?? ""} disabled={disabled} onOpenChange={setSettingsOpen} onValueChange={value => void changeSettings({ textSize: textSizeSchema.parse(value) })}>
          <SelectTrigger id="text-size" size="sm" className="w-full"><SelectValue placeholder="Not reported by the device" /></SelectTrigger>
          <SelectContent><SelectGroup>{textSizeSchema.options.map(value => <SelectItem value={value} key={value}>{textSizeLabel(value)}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      {preferences.map(({ key, id, label }) => <Field key={key} orientation="horizontal" data-disabled={disabled || state.settings[key] === undefined}>
        <FieldContent><FieldLabel htmlFor={id}>{label}</FieldLabel>{state.session && state.settings[key] === undefined && <FieldDescription>Not reported by the device</FieldDescription>}</FieldContent>
        <Switch id={id} checked={state.settings[key] ?? false} disabled={disabled || state.settings[key] === undefined} onCheckedChange={value => void changeSettings({ [key]: value })} />
      </Field>)}
    </FieldGroup>
    <div className="settings-footer">
      <p>Changes stay on the device until you change them back.</p>
      <Button id="open-settings" variant="ghost" size="sm" disabled={disabled} onClick={() => void performAction({ type: "openSettings" })}>Open Settings<ArrowUpRight data-icon="inline-end" /></Button>
    </div>
  </div>;
}
