import { ChevronRight, Crosshair, LoaderCircle, MousePointer2, Search, SquareMousePointer, Workflow } from "lucide-react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.js";
import { Separator } from "./ui/separator.js";
import { Switch } from "./ui/switch.js";
import type { ScreenElement } from "../elements.js";
import { performAction, setAccessibility, type ViewerState } from "../viewer-controller.js";

export function ElementInspector({ state, elements, selected, query, onQuery, onSelect, onHover, mappingReady }: {
  state: ViewerState; elements: ScreenElement[]; selected?: ScreenElement; query: string;
  onQuery: (value: string) => void; onSelect: (element: ScreenElement) => void; onHover: (element?: ScreenElement) => void; mappingReady: boolean;
}) {
  const enabled = Boolean(state.session?.accessibilityEnabled);
  const disabled = !state.session || state.busy || state.ended;
  const reading = state.busy && enabled && !state.capture;
  const filter = query.trim().toLocaleLowerCase();
  const filtered = elements.filter(item => [item.label, item.identifier, item.role, item.value, item.placeholder].some(value => value?.toLocaleLowerCase().includes(filter)));
  return <div className="elements-pane">
    <div className="inspector-heading"><h2>Accessibility tree</h2><Switch id="accessibility" aria-label="Enable accessibility tree" checked={enabled} disabled={disabled} onCheckedChange={value => void setAccessibility(value)} /></div>
    <InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput id="tree-search" type="search" placeholder="Search labels, roles, values…" aria-label="Search accessibility tree" disabled={!enabled || !state.session} value={query} onChange={event => onQuery(event.target.value)} /></InputGroup>
    <div className="element-summary" id="tree-summary">{enabled ? `${filtered.length} ${filtered.length === 1 ? "element" : "elements"}${filter ? " matching" : " on screen"}` : "Enable to inspect what’s on screen."}</div>
    <div className="element-list" aria-label="Screen elements">
      {!enabled || !filtered.length ? <Empty>
        <EmptyHeader><EmptyMedia variant="icon">{reading ? <LoaderCircle className="animate-spin" /> : <Workflow />}</EmptyMedia><EmptyTitle>{reading ? "Reading screen…" : !enabled ? "See what’s on screen" : filter ? "No matching elements" : "No elements reported"}</EmptyTitle><EmptyDescription>{reading ? "Elements will appear with the first screen." : !enabled ? "Enable the tree to map elements to the simulator." : filter ? "Try another label, role, or value." : "Refresh the screen or open another app."}</EmptyDescription></EmptyHeader>
        {!enabled && <Button variant="outline" disabled={disabled} onClick={() => void setAccessibility(true)}>Enable accessibility tree</Button>}
      </Empty> : filtered.map(item => <Button key={item.ref} variant={selected?.ref === item.ref ? "secondary" : "ghost"} className="element-row" data-element-ref={item.ref} aria-pressed={selected?.ref === item.ref} disabled={!mappingReady || state.ended} onClick={() => onSelect(item)} onMouseEnter={() => onHover(item)} onMouseLeave={() => onHover(undefined)} onFocus={() => onHover(item)} onBlur={() => onHover(undefined)}>
        <span className="element-symbol"><SquareMousePointer /></span><span className="element-copy"><span className="element-label">{item.label || item.identifier || item.placeholder || item.role}</span><span className="element-meta">{item.role}{item.disabled ? " · Disabled" : ""}{item.value ? ` · ${item.value}` : ""}</span></span><span className="element-point">{Math.round(item.point.x)}, {Math.round(item.point.y)}</span><ChevronRight data-icon="inline-end" />
      </Button>)}
    </div>
    <Separator />
    {selected ? <div className="element-detail">
      <div className="element-detail-heading"><div className="element-detail-name"><h3>{selected.label || selected.identifier || selected.role}</h3><Badge variant="secondary">{selected.role}</Badge></div><Button id="tap-element" size="sm" disabled={disabled || !mappingReady || selected.disabled} onClick={() => void performAction({ type: "tap", element: { ref: selected.ref } })}><MousePointer2 data-icon="inline-start" />Tap element</Button></div>
      <dl className="element-properties"><dt>Tap point</dt><dd>{selected.point.x}, {selected.point.y} pt</dd><dt>Bounds</dt><dd>{Math.round(selected.frame.width)} × {Math.round(selected.frame.height)} pt</dd>{selected.identifier && <><dt>Identifier</dt><dd>{selected.identifier}</dd></>}{selected.value && <><dt>Value</dt><dd>{selected.value}</dd></>}</dl>
    </div> : <div className="selection-hint"><Crosshair /><p>Select an element to highlight it on the screen. Use Inspect to select from the simulator.</p></div>}
  </div>;
}
