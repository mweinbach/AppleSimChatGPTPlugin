import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { Button } from "./ui/button.js";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "./ui/field.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";
import { Separator } from "./ui/separator.js";
import { Switch } from "./ui/switch.js";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.js";
import { textSizeSchema } from "../shared.js";
import { changeSettings, performAction, setSettingsOpen, type ViewerState } from "../viewer-controller.js";

const preferences = [
  { key: "reduceMotion", id: "reduce-motion", label: "Reduce Motion", description: "Limit animations and transitions." },
  { key: "reduceTransparency", id: "reduce-transparency", label: "Reduce Transparency", description: "Use solid backgrounds for clarity." },
  { key: "increasedContrast", id: "increased-contrast", label: "Increase Contrast", description: "Give controls more definition." },
] as const;
const textSizeLabel = (value: string) => value.replace(/^accessibility-/, "Accessibility · ").replaceAll("-", " ").replace(/^./, letter => letter.toUpperCase());

export function DeviceSettings({ state }: { state: ViewerState }) {
  const disabled = !state.session || state.busy || state.ended;
  return <div className="settings-pane">
    <div className="inspector-heading"><h2>Device settings</h2><Button id="open-settings" variant="ghost" size="sm" disabled={disabled} onClick={() => void performAction({ type: "openSettings" })}>Open Settings<ArrowUpRight data-icon="inline-end" /></Button></div>
    <FieldGroup>
      <Field orientation="horizontal" data-disabled={disabled}>
        <FieldContent><FieldLabel>Appearance</FieldLabel><FieldDescription>On the connected device.</FieldDescription></FieldContent>
        <ToggleGroup type="single" variant="outline" spacing={0} value={state.settings.appearance ?? ""} disabled={disabled} onValueChange={value => { if (value === "light" || value === "dark") void changeSettings({ appearance: value }); }} aria-label="Device appearance">
          <ToggleGroupItem value="light" id="appearance-light" aria-label="Light appearance"><Sun data-icon="inline-start" />Light</ToggleGroupItem>
          <ToggleGroupItem value="dark" id="appearance-dark" aria-label="Dark appearance"><Moon data-icon="inline-start" />Dark</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Separator />
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="text-size">Text size</FieldLabel>
        <Select value={state.settings.textSize ?? ""} disabled={disabled} onOpenChange={setSettingsOpen} onValueChange={value => void changeSettings({ textSize: textSizeSchema.parse(value) })}>
          <SelectTrigger id="text-size" className="w-full"><SelectValue placeholder="Not reported by device" /></SelectTrigger>
          <SelectContent><SelectGroup>{textSizeSchema.options.map(value => <SelectItem value={value} key={value}>{textSizeLabel(value)}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <FieldDescription>Dynamic Type, including accessibility sizes.</FieldDescription>
      </Field>
      <Separator />
      {preferences.map(({ key, id, label, description }) => <Field key={key} orientation="horizontal" data-disabled={disabled || state.settings[key] === undefined}>
        <FieldContent><FieldLabel htmlFor={id}>{label}</FieldLabel><FieldDescription>{state.session && state.settings[key] === undefined ? "Not reported by device." : description}</FieldDescription></FieldContent>
        <Switch id={id} checked={state.settings[key] ?? false} disabled={disabled || state.settings[key] === undefined} onCheckedChange={value => void changeSettings({ [key]: value })} />
      </Field>)}
    </FieldGroup>
  </div>;
}
