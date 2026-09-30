/**
 * Turns Xcode's accessibility hierarchy dump into a short list of on-screen
 * elements an agent can read and target by reference.
 *
 * Dump lines look like:
 *   `    Button, {{16.0, 380.3}, {370.0, 52.0}}, identifier: 'x', label: 'General', value: 0%, hitPoint: {201.0, 406.3}`
 * Values are unquoted and may contain commas, so attributes are split on the
 * known keys that follow them rather than on commas.
 */

export interface Rect { x: number; y: number; width: number; height: number }

export interface HierarchyNode {
  depth: number;
  role: string;
  frame: Rect;
  hitPoint?: { x: number; y: number };
  identifier?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  selected: boolean;
  disabled: boolean;
  focused: boolean;
}

export interface ScreenElement {
  ref: string;
  role: string;
  label?: string;
  identifier?: string;
  value?: string;
  placeholder?: string;
  selected?: boolean;
  disabled?: boolean;
  focused?: boolean;
  frame: Rect;
  point: { x: number; y: number };
}

export interface ScreenSummary {
  bundleId?: string;
  appLabel?: string;
  elements: ScreenElement[];
}

const nodePattern = /^(\s*)([A-Za-z]+), \{\{(-?[\d.]+), (-?[\d.]+)\}, \{(-?[\d.]+), (-?[\d.]+)\}\}(.*)$/;
const keys = ['identifier', 'label', 'value', 'placeholderValue', 'title', 'hitPoint'];
const attributePattern = new RegExp(`, (${keys.join('|')}): (.*?)(?=, (?:${keys.join('|')}): |, (?:Selected|Disabled|Enabled|Focused|Keyboard Focused)(?:,|$)|$)`, 'g');

const interactive = new Set(['Button', 'Cell', 'Link', 'TextField', 'SecureTextField', 'SearchField', 'TextView', 'Switch', 'Toggle', 'Slider', 'Stepper', 'SegmentedControl', 'Picker', 'PickerWheel', 'DatePicker', 'Tab', 'Icon', 'Key', 'MenuItem', 'MenuBarItem', 'CheckBox', 'RadioButton', 'PageIndicator', 'ToolbarButton', 'PopUpButton', 'ComboBox', 'ColorWell', 'Stepper', 'DisclosureTriangle', 'Incrementor']);
const informational = new Set(['StaticText', 'Image', 'NavigationBar', 'Alert', 'Sheet', 'ActivityIndicator', 'ProgressIndicator', 'Map', 'WebView', 'Heading']);
const editable = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);

function unquote(raw: string): string {
  const text = raw.trim();
  return text.length >= 2 && text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text;
}

export function parseHierarchy(hierarchy: string): { bundleId?: string; appLabel?: string; nodes: HierarchyNode[] } {
  const nodes: HierarchyNode[] = [];
  let bundleId: string | undefined;
  let appLabel: string | undefined;
  for (const line of hierarchy.split('\n')) {
    const bundle = line.match(/^Application bundle identifier: (\S+)/);
    if (bundle) { bundleId = bundle[1]; continue; }
    const application = line.match(/^Application, pid: \d+(?:, label: '(.*)')?/);
    if (application) { appLabel = application[1]?.trim() || undefined; continue; }
    const match = line.match(nodePattern);
    if (!match) continue;
    const [, indent, role, x, y, width, height, rest] = match;
    const node: HierarchyNode = {
      depth: indent!.length, role: role!,
      frame: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
      selected: /, Selected(?:,|$)/.test(rest!), disabled: /, Disabled(?:,|$)/.test(rest!), focused: /, (?:Keyboard )?Focused(?:,|$)/.test(rest!),
    };
    for (const [, key, raw] of rest!.matchAll(attributePattern)) {
      if (key === 'hitPoint') {
        const point = raw!.match(/\{(-?[\d.]+), (-?[\d.]+)\}/);
        if (point) node.hitPoint = { x: Number(point[1]), y: Number(point[2]) };
      } else {
        const text = unquote(raw!);
        if (!text) continue;
        if (key === 'placeholderValue') node.placeholder = text;
        else node[key as 'identifier' | 'label' | 'value' | 'title'] = text;
      }
    }
    nodes.push(node);
  }
  return { bundleId, appLabel, nodes };
}

function onScreen(node: HierarchyNode, bounds: { width: number; height: number }): boolean {
  const point = node.hitPoint ?? { x: node.frame.x + node.frame.width / 2, y: node.frame.y + node.frame.height / 2 };
  return node.frame.width > 1 && node.frame.height > 1
    && point.x >= 0 && point.y >= 0 && point.x < bounds.width && point.y < bounds.height;
}

function isScrollBar(node: HierarchyNode): boolean {
  return /scroll bar/i.test(node.label ?? '');
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Keeps controls and meaningful content. Text or images that only repeat an
 * enclosing control's label are dropped, as are exact duplicates.
 */
export function summarizeHierarchy(hierarchy: string, bounds: { width: number; height: number }): ScreenSummary {
  const { bundleId, appLabel, nodes } = parseHierarchy(hierarchy);
  const elements: ScreenElement[] = [];
  const seen = new Set<string>();
  // Labels of the enclosing kept controls, indexed by depth.
  const ancestors: { depth: number; label: string; identifier?: string }[] = [];
  for (const node of nodes) {
    while (ancestors.length && ancestors.at(-1)!.depth >= node.depth) ancestors.pop();
    if (!onScreen(node, bounds) || isScrollBar(node)) continue;
    const text = node.label ?? node.title;
    const control = interactive.has(node.role);
    const content = informational.has(node.role) && Boolean(text || (node.role === 'NavigationBar' && node.identifier));
    const labelledOther = node.role === 'Other' && Boolean(text) && text !== ' ';
    if (!control && !content && !labelledOther) continue;
    if (!control && text && ancestors.some(ancestor => ancestor.label.includes(text))) continue;
    // Table rows often nest a Button inside a Cell with the same label; one target is enough.
    // Value-bearing controls such as switches stay, since their state matters.
    if ((node.role === 'Button' || node.role === 'Cell') && text && ancestors.some(ancestor => ancestor.label === text && (!ancestor.identifier || !node.identifier || ancestor.identifier === node.identifier))) continue;
    if (control && !text && !node.identifier && !node.value && !node.placeholder && !editable.has(node.role)) continue;
    const point = node.hitPoint ?? { x: node.frame.x + node.frame.width / 2, y: node.frame.y + node.frame.height / 2 };
    const key = [node.role, text, node.identifier, node.value, round(point.x), round(point.y)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const element: ScreenElement = { ref: `e${elements.length + 1}`, role: node.role, frame: node.frame, point: { x: round(point.x), y: round(point.y) } };
    if (text) element.label = text;
    if (node.identifier && node.identifier !== text) element.identifier = node.identifier;
    if (node.value) element.value = node.value;
    if (node.placeholder && node.placeholder !== text) element.placeholder = node.placeholder;
    if (node.selected) element.selected = true;
    if (node.disabled) element.disabled = true;
    if (node.focused) element.focused = true;
    elements.push(element);
    if (text && (control || labelledOther)) ancestors.push({ depth: node.depth, label: text, identifier: node.identifier });
  }
  return { bundleId, appLabel, elements };
}

const quote = (text: string, limit = 80) => JSON.stringify(text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export function formatElement(element: ScreenElement): string {
  const parts = [`[${element.ref}]`, element.role];
  if (element.label) parts.push(quote(element.label));
  if (element.identifier) parts.push(`id=${quote(element.identifier, 60)}`);
  if (element.value) parts.push(`value=${quote(element.value, 40)}`);
  if (element.placeholder) parts.push(`placeholder=${quote(element.placeholder, 40)}`);
  for (const flag of ['selected', 'disabled', 'focused'] as const) if (element[flag]) parts.push(flag);
  parts.push(`@ ${element.point.x},${element.point.y}`);
  return parts.join(' ');
}

export interface ElementQuery { ref?: string; label?: string; identifier?: string; role?: string; index?: number }

/** Resolves a ref or a label/identifier query against the latest element list. */
export function resolveElement(elements: ScreenElement[], query: ElementQuery): ScreenElement {
  if (query.ref) {
    const match = elements.find(element => element.ref === query.ref);
    if (!match) throw new Error(`No element ${query.ref} on the current screen. Capture again and use a ref from the latest element list.`);
    return match;
  }
  if (!query.label && !query.identifier && !query.role) throw new Error('Target an element by ref, label, identifier or role.');
  const normalize = (text?: string) => (text ?? '').trim().toLocaleLowerCase();
  const role = normalize(query.role);
  const candidates = elements.filter(element => !role || normalize(element.role) === role);
  const matchesOn = (exact: boolean) => candidates.filter(element => {
    const checks: boolean[] = [];
    if (query.identifier) checks.push(exact ? normalize(element.identifier) === normalize(query.identifier) : normalize(element.identifier).includes(normalize(query.identifier)));
    if (query.label) checks.push(exact ? normalize(element.label) === normalize(query.label) : normalize(element.label).includes(normalize(query.label)));
    return checks.every(Boolean);
  });
  let matches = matchesOn(true);
  if (!matches.length) matches = matchesOn(false);
  if (!matches.length) throw new Error(`No element matches ${JSON.stringify(query)}. Capture again or use a ref from the element list.`);
  if (query.index !== undefined) {
    const chosen = matches[query.index];
    if (!chosen) throw new Error(`Only ${matches.length} elements match ${JSON.stringify({ ...query, index: undefined })}.`);
    return chosen;
  }
  // Several nodes often describe one control (an icon and its tappable parent). Prefer controls.
  const controls = matches.filter(element => interactive.has(element.role));
  const pool = controls.length ? controls : matches;
  if (pool.length > 1) {
    throw new Error(`${pool.length} elements match ${JSON.stringify(query)}; pass a ref or index:\n${pool.slice(0, 8).map(formatElement).join('\n')}`);
  }
  return pool[0]!;
}

export function isEditable(element: ScreenElement): boolean {
  return editable.has(element.role);
}
