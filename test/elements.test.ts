import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatElement, parseHierarchy, resolveElement, summarizeHierarchy } from "../src/elements.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}-hierarchy.txt`, import.meta.url), "utf8");
const bounds = { width: 402, height: 874 };

test("parses roles, frames, quoted attributes and unquoted values containing commas", () => {
  const { bundleId, nodes } = parseHierarchy(fixture("springboard"));
  assert.equal(bundleId, "com.apple.springboard");
  const widget = nodes.find(node => node.identifier === "Calendar" && node.value?.includes("Stack"))!;
  assert.deepEqual({ role: widget.role, label: widget.label, value: widget.value, hitPoint: widget.hitPoint }, { role: "Icon", label: "Calendar", value: "Widget, Stack", hitPoint: { x: 293.8, y: 183.5 } });
  const search = parseHierarchy(fixture("settings")).nodes.find(node => node.role === "SearchField")!;
  assert.equal(search.placeholder, "Search");
  const flagged = parseHierarchy("  Button, {{0.0, 0.0}, {10.0, 10.0}}, label: 'It's on', Selected, hitPoint: {5.0, 5.0}").nodes[0]!;
  assert.deepEqual([flagged.label, flagged.selected, flagged.hitPoint], ["It's on", true, { x: 5, y: 5 }]);
});

test("summaries keep controls and content, and drop wrappers, duplicates and repeated labels", () => {
  const home = summarizeHierarchy(fixture("springboard"), bounds);
  assert.ok(home.elements.length < 25, `${home.elements.length} elements`);
  assert.deepEqual(home.elements.filter(element => element.role === "Icon").map(element => element.label), ["Maps", "Calendar", "Calendar", "Photos", "Maps", "News", "Health", "Wallet", "Siri", "Settings", "Safari", "Messages"]);
  const settings = summarizeHierarchy(fixture("settings"), bounds);
  assert.equal(settings.appLabel, "Settings");
  assert.equal(settings.elements.filter(element => element.label === "General").length, 1, "the row's StaticText repeats its Button");
  assert.equal(settings.elements.filter(element => element.label === "Dictate").length, 1);
  assert.equal(settings.elements.some(element => /scroll bar/.test(element.label ?? "")), false);
  assert.deepEqual(settings.elements.map(element => element.ref).slice(0, 3), ["e1", "e2", "e3"]);
  assert.equal(formatElement(settings.elements.find(element => element.label === "General")!), '[e6] Button "General" id="com.apple.settings.general" @ 201,406.3 370×52');
});

test("resolution prefers exact labels and controls, and explains ambiguity", () => {
  const { elements } = summarizeHierarchy(fixture("springboard"), bounds);
  assert.equal(resolveElement(elements, { label: "settings" }).point.x, 339.8);
  assert.throws(() => resolveElement(elements, { label: "Maps" }), /2 elements match[\s\S]*\[e1\][\s\S]*\[e5\]/);
  assert.equal(resolveElement(elements, { label: "Maps", index: 1 }).point.y, 334);
  assert.equal(resolveElement(elements, { label: "Mess" }).label, "Messages");
  assert.throws(() => resolveElement(elements, { label: "Nope" }), /No element matches/);
  const settings = summarizeHierarchy(fixture("settings"), bounds).elements;
  assert.equal(resolveElement(settings, { role: "SearchField" }).point.y, 822);
  assert.throws(() => resolveElement(settings, { role: "Button" }), /elements match/);
});

test("a control nested in a row with the same label is listed once", () => {
  const row = [
    "Cell, {{16.0, 134.0}, {370.0, 52.0}}, identifier: 'NAME_CELL_ID', label: 'Name, iPhone', hitPoint: {201.0, 160.2}",
    " Button, {{16.0, 134.0}, {352.0, 52.0}}, identifier: 'NAME_CELL_ID', label: 'Name, iPhone', hitPoint: {191.8, 160.2}",
    "  StaticText, {{36.0, 146.0}, {48.0, 28.0}}, label: 'Name', hitPoint: {60.0, 160.0}",
    "Cell, {{16.0, 187.0}, {370.0, 52.0}}, label: 'Model', hitPoint: {201.0, 213.0}",
    " Switch, {{300.0, 197.0}, {63.0, 28.0}}, label: 'Model', value: 1, hitPoint: {331.0, 211.0}",
  ].join("\n");
  const elements = summarizeHierarchy(row, bounds).elements;
  assert.deepEqual(elements.map(element => element.role), ["Cell", "Cell", "Switch"]);
  assert.equal(elements[2]!.value, "1");
});
