import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ImagePlus, Keyboard, Send, Smartphone, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.js";
import { Button } from "./ui/button.js";
import { Field, FieldGroup, FieldLabel } from "./ui/field.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";
import { TooltipProvider } from "./ui/tooltip.js";
import { DevicePicker } from "./device-picker.js";
import { DeviceSettings } from "./device-settings.js";
import { ElementInspector } from "./element-inspector.js";
import { ScreenViewer } from "./screen-viewer.js";
import { summarizeHierarchy, type ScreenElement } from "../elements.js";
import { elementAtPoint } from "../screen-mapping.js";
import { coordinateSpaceMatchesFrame } from "../video-player.js";
import { attachScreen, getSnapshot, performAction, setAccessibility, setInspectorMode, subscribe } from "../viewer-controller.js";

// Resolve selection against each new observation so an old ref cannot tap a new row.
const sameElement = (left: ScreenElement, right: ScreenElement) => left.role === right.role && left.label === right.label && left.identifier === right.identifier && left.frame.x === right.frame.x && left.frame.y === right.frame.y && left.frame.width === right.frame.width && left.frame.height === right.frame.height;

export function DeviceHub() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [selection, setSelection] = useState<ScreenElement>();
  const [hover, setHover] = useState<ScreenElement>();
  const [inspecting, setInspecting] = useState(false);
  const [tab, setTab] = useState("elements");
  const hierarchy = state.session?.accessibilityEnabled ? state.capture?.hierarchy : undefined;
  const bounds = state.capture?.coordinateSpace;
  const elements = useMemo(() => hierarchy && bounds ? summarizeHierarchy(hierarchy, bounds).elements : [], [hierarchy, bounds?.width, bounds?.height]);
  const selected = selection && elements.find(item => sameElement(item, selection));
  const highlighted = hover && elements.find(item => sameElement(item, hover)) || selected;
  const mappingReady = Boolean(bounds && (!state.videoReady || !state.videoDimensions || coordinateSpaceMatchesFrame(bounds, state.videoDimensions)));
  const disabled = !state.session || state.busy || state.ended;

  useEffect(() => { setSelection(undefined); setHover(undefined); setQuery(""); setText(""); setInspecting(false); }, [state.session?.id]);
  useEffect(() => { if (!state.session?.accessibilityEnabled) setInspecting(false); }, [state.session?.accessibilityEnabled]);
  useEffect(() => {
    setInspectorMode(inspecting, point => {
      setSelection(elementAtPoint(elements, point));
      setHover(undefined);
      setQuery("");
      setTab("elements");
    });
  }, [inspecting, elements]);

  async function inspect(value: boolean) {
    if (value && !state.session?.accessibilityEnabled) {
      await setAccessibility(true);
      if (!getSnapshot().session?.accessibilityEnabled) return;
    }
    setInspecting(value);
    if (value) setTab("elements");
  }

  async function sendText(event: React.FormEvent) {
    event.preventDefault();
    if (!text || disabled) return;
    const submitted = text;
    const epoch = state.session?.id;
    const succeeded = await performAction({ type: "type", text: submitted });
    if (succeeded && getSnapshot().session?.id === epoch) setText(current => current === submitted ? "" : current);
  }

  return <TooltipProvider><div className="hub" aria-busy={state.busy}>
    <header className="hub-header"><Smartphone className="brand-icon" aria-hidden="true" /><div><h1>Apple Device Hub</h1><p>Simulators and connected Apple devices</p></div></header>
    <DevicePicker state={state} />
    {state.hub.warnings.length > 0 && <Alert variant="destructive"><TriangleAlert /><AlertTitle>Device discovery</AlertTitle><AlertDescription>{state.hub.warnings.map(warning => <p key={warning}>{warning}</p>)}</AlertDescription></Alert>}
    <div className="workspace">
      <ScreenViewer state={state} highlight={highlighted} inspecting={inspecting} onInspect={value => void inspect(value)} mappingReady={mappingReady} />
      <aside className="inspector-panel" aria-label="Device inspection and settings"><Tabs value={tab} onValueChange={value => { setTab(value); setHover(undefined); }}>
        <TabsList variant="line" className="w-full"><TabsTrigger value="elements">Elements</TabsTrigger><TabsTrigger value="settings">Settings</TabsTrigger></TabsList>
        <TabsContent value="elements"><ElementInspector state={state} elements={elements} selected={selected} query={query} onQuery={setQuery} onSelect={setSelection} onHover={setHover} mappingReady={mappingReady} /></TabsContent>
        <TabsContent value="settings"><DeviceSettings state={state} /></TabsContent>
      </Tabs></aside>
    </div>
    <footer className="interaction-bar">
      <form id="type-form" onSubmit={event => void sendText(event)}><FieldGroup><Field orientation="horizontal" data-disabled={disabled}><FieldLabel htmlFor="type-text" className="sr-only">Text to type on device</FieldLabel><InputGroup><InputGroupAddon><Keyboard /></InputGroupAddon><InputGroupInput id="type-text" placeholder="Type text on device…" value={text} disabled={disabled} autoComplete="off" maxLength={10000} onChange={event => setText(event.target.value)} /></InputGroup><Button type="submit" disabled={disabled || !text}><Send data-icon="inline-start" />Send</Button></Field></FieldGroup></form>
      <Button id="attach" variant="outline" disabled={disabled || !state.capture || !state.contextEnabled} title={state.attachmentStatus} onClick={() => void attachScreen()}><ImagePlus data-icon="inline-start" />Attach current screen</Button>
      <div id="notice" className="notice" data-error={state.noticeError} role="status" aria-live="polite"><span className="status-dot" data-connected={Boolean(state.session)} /><span id="notice-text">{state.notice}</span></div>
    </footer>
    <p id="attachment-status" className="sr-only" aria-live="polite">{state.attachmentStatus}</p>
  </div></TooltipProvider>;
}
