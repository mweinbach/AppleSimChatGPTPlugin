import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";
import { TooltipProvider } from "./ui/tooltip.js";
import { DeviceBar } from "./device-bar.js";
import { DeviceSettings } from "./device-settings.js";
import { ElementInspector } from "./element-inspector.js";
import { DeviceControls, ScreenViewer, type Panel } from "./screen-viewer.js";
import { summarizeHierarchy, type ScreenElement } from "../elements.js";
import { elementAtPoint } from "../screen-mapping.js";
import { coordinateSpaceMatchesFrame } from "../video-player.js";
import { getSnapshot, setAccessibility, setInspectorMode, subscribe } from "../viewer-controller.js";

// Resolve selection against each new observation so an old ref cannot tap a new row.
const sameElement = (left: ScreenElement, right: ScreenElement) => left.role === right.role && left.label === right.label && left.identifier === right.identifier && left.frame.x === right.frame.x && left.frame.y === right.frame.y && left.frame.width === right.frame.width && left.frame.height === right.frame.height;
const matches = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches;
/** Matches the CSS breakpoint where the panel becomes a side column and controls move to the top bar. */
const WIDE = "(min-width: 680px)";
function useMedia(query: string) {
  return useSyncExternalStore(change => {
    if (typeof matchMedia !== "function") return () => {};
    const list = matchMedia(query);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, () => matches(query));
}

export function DeviceHub() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const wide = useMedia(WIDE);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<ScreenElement>();
  const [hover, setHover] = useState<ScreenElement>();
  const [inspecting, setInspecting] = useState(false);
  const [agentView, setAgentView] = useState(false);
  const [typing, setTyping] = useState(false);
  const [panel, setPanel] = useState<Panel | undefined>(() => matches("(min-width: 900px)") ? "elements" : undefined);
  const hierarchy = state.session?.accessibilityEnabled ? state.capture?.hierarchy : undefined;
  const bounds = state.capture?.coordinateSpace;
  const elements = useMemo(() => hierarchy && bounds ? summarizeHierarchy(hierarchy, bounds).elements : [], [hierarchy, bounds?.width, bounds?.height]);
  const selected = selection && elements.find(item => sameElement(item, selection));
  const hovered = hover && elements.find(item => sameElement(item, hover));
  const highlighted = hovered || selected;
  const mappingReady = Boolean(bounds && (!state.videoReady || !state.videoDimensions || coordinateSpaceMatchesFrame(bounds, state.videoDimensions)));

  useEffect(() => { setSelection(undefined); setHover(undefined); setQuery(""); setInspecting(false); setAgentView(false); setTyping(false); }, [state.session?.id]);
  useEffect(() => { if (!state.session?.accessibilityEnabled) { setInspecting(false); setAgentView(false); } }, [state.session?.accessibilityEnabled]);
  useEffect(() => {
    setInspectorMode(inspecting, point => {
      setSelection(elementAtPoint(elements, point));
      setHover(undefined);
      setQuery("");
      setInspecting(false);
      setPanel("elements");
    });
  }, [inspecting, elements]);

  async function needElements() {
    if (state.session?.accessibilityEnabled) return true;
    await setAccessibility(true);
    return Boolean(getSnapshot().session?.accessibilityEnabled);
  }
  async function showAgentView(value: boolean) {
    if (value && !await needElements()) return;
    setAgentView(value);
  }
  async function inspect(value: boolean) {
    if (value && !await needElements()) return;
    setInspecting(value);
  }

  const controls = state.session && <DeviceControls state={state} typing={typing} agentView={agentView} panel={panel} onTyping={setTyping} onAgentView={value => void showAgentView(value)} onPanel={setPanel} />;
  return <TooltipProvider delayDuration={400}><div className="hub" data-connected={Boolean(state.session)} data-layout={wide ? "wide" : "narrow"} aria-busy={state.busy}>
    <DeviceBar state={state} controls={wide ? controls : undefined} />
    <div className="workspace" data-panel={Boolean(state.session && panel)}>
      <ScreenViewer state={state} elements={elements} highlight={highlighted} hovered={hovered} agentView={agentView} inspecting={inspecting} mappingReady={mappingReady}
        typing={typing} dock={wide ? undefined : controls} onHover={setHover} onTyping={setTyping} />
      {state.session && panel && <aside className="panel" aria-label="Device inspection and settings">
        <Tabs value={panel} onValueChange={value => { setPanel(value as Panel); setHover(undefined); }}>
          <div className="panel-head">
            <TabsList variant="line"><TabsTrigger value="elements">Elements</TabsTrigger><TabsTrigger value="appearance">Appearance</TabsTrigger></TabsList>
            <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={() => setPanel(undefined)}><X /></Button>
          </div>
          <TabsContent value="elements"><ElementInspector state={state} elements={elements} selected={selected} query={query} inspecting={inspecting} onQuery={setQuery} onSelect={setSelection} onHover={setHover} onInspect={value => void inspect(value)} mappingReady={mappingReady} /></TabsContent>
          <TabsContent value="appearance"><DeviceSettings state={state} /></TabsContent>
        </Tabs>
      </aside>}
    </div>
  </div></TooltipProvider>;
}
