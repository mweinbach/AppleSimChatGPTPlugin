import { Crosshair, LoaderCircle, MousePointer2, RefreshCw, Search, Workflow } from "lucide-react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.js";
import { Toggle } from "./ui/toggle.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";
import type { ScreenElement } from "../elements.js";
import { performAction, refreshCapture, setAccessibility, type ViewerState } from "../viewer-controller.js";

export function ElementInspector({ state, elements, selected, query, inspecting, onQuery, onSelect, onHover, onInspect, mappingReady }: {
  state: ViewerState; elements: ScreenElement[]; selected?: ScreenElement; query: string; inspecting: boolean;
  onQuery: (value: string) => void; onSelect: (element: ScreenElement) => void; onHover: (element?: ScreenElement) => void; onInspect: (value: boolean) => void; mappingReady: boolean;
}) {
  const enabled = Boolean(state.session?.accessibilityEnabled);
  const disabled = !state.session || state.busy || state.ended;
  const reading = state.busy && enabled && !state.capture;
  const filter = query.trim().toLocaleLowerCase();
  const filtered = elements.filter(item => [item.ref, item.label, item.identifier, item.role, item.value, item.placeholder].some(value => value?.toLocaleLowerCase().includes(filter)));
  const observed = state.capture && new Date(state.capture.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return <div className="elements-pane">
    <div className="pane-toolbar">
      <p className="pane-summary" id="tree-summary">{enabled ? <>{filtered.length} {filtered.length === 1 ? "element" : "elements"}{filter ? " match" : ""}{observed && <span className="pane-time"> · {observed}</span>}</> : "Elements are off"}</p>
      <Tooltip><TooltipTrigger asChild><Toggle id="inspect" size="sm" pressed={inspecting} disabled={disabled || !enabled || !mappingReady} onPressedChange={onInspect} aria-label="Pick an element on the screen"><Crosshair /></Toggle></TooltipTrigger><TooltipContent>Pick an element on the screen</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><Button id="capture" variant="ghost" size="icon-sm" disabled={disabled} onClick={() => void refreshCapture()} aria-label="Read the screen again"><RefreshCw /></Button></TooltipTrigger><TooltipContent>Read the screen again</TooltipContent></Tooltip>
    </div>
    {enabled && <InputGroup className="pane-search"><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput id="tree-search" type="search" placeholder="Filter by ref, label, role or value" aria-label="Filter elements" disabled={!state.session} value={query} onChange={event => onQuery(event.target.value)} /></InputGroup>}
    <div className="element-list" aria-label="Screen elements">
      {!enabled || !filtered.length ? <Empty className="pane-empty">
        <EmptyHeader><EmptyMedia variant="icon">{reading ? <LoaderCircle className="animate-spin" /> : <Workflow />}</EmptyMedia><EmptyTitle>{reading ? "Reading the screen…" : !enabled ? "See what the agent sees" : filter ? "No matching elements" : "No elements on this screen"}</EmptyTitle><EmptyDescription>{reading ? "Elements appear with the first observation." : !enabled ? "Read accessibility elements to list the labels and refs the agent acts on." : filter ? "Try a ref, label, role or value." : "Read the screen again after it changes."}</EmptyDescription></EmptyHeader>
        {!enabled && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void setAccessibility(true)}>Read elements</Button>}
      </Empty> : filtered.map(item => <button type="button" key={item.ref} className="element-row" data-element-ref={item.ref} aria-pressed={selected?.ref === item.ref} disabled={!mappingReady || state.ended} onClick={() => onSelect(item)} onMouseEnter={() => onHover(item)} onMouseLeave={() => onHover(undefined)} onFocus={() => onHover(item)} onBlur={() => onHover(undefined)}>
        <span className="ref-badge">{item.ref}</span>
        <span className="element-copy"><span className="element-label">{item.label || item.identifier || item.placeholder || item.role}</span><span className="element-meta">{item.role}{item.disabled ? " · disabled" : ""}{item.selected ? " · selected" : ""}{item.value ? ` · ${item.value}` : ""}</span></span>
      </button>)}
    </div>
    {selected && <div className="element-detail">
      <div className="element-detail-heading">
        <div className="element-detail-name"><h3>{selected.label || selected.identifier || selected.role}</h3><span className="element-detail-tags"><span className="ref-badge">{selected.ref}</span><Badge variant="secondary">{selected.role}</Badge></span></div>
        <Button id="tap-element" size="sm" disabled={disabled || !mappingReady || selected.disabled} onClick={() => void performAction({ type: "tap", element: { ref: selected.ref } })}><MousePointer2 data-icon="inline-start" />Tap</Button>
      </div>
      <dl className="element-properties">
        {selected.identifier && <><dt>Identifier</dt><dd>{selected.identifier}</dd></>}
        {selected.value && <><dt>Value</dt><dd>{selected.value}</dd></>}
        <dt>Size</dt><dd>{Math.round(selected.frame.width)} × {Math.round(selected.frame.height)} pt</dd>
        <dt>Tap point</dt><dd>{selected.point.x}, {selected.point.y}</dd>
      </dl>
    </div>}
    {enabled && <p className="pane-footer">The agent sees these refs with each screenshot. <Button id="accessibility" variant="link" size="xs" className="pane-footer-action" disabled={disabled} onClick={() => void setAccessibility(false)}>Send screenshots only</Button></p>}
  </div>;
}
