import type { Page } from 'playwright';
import { redactText, redactUrl } from '../redaction.ts';
import { withCdp } from './cdp.ts';

/** Raw node from CDP Accessibility.getFullAXTree (only the fields NCrawl reads). */
export interface RawAxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface AxNode {
  id: string;
  parentId: string | null;
  role: string;
  name: string;
  level?: number;
  expanded?: boolean;
  checked?: string;
  selected?: boolean;
  disabled?: boolean;
  focusable?: boolean;
  required?: boolean;
  hasPopup?: string;
  url?: string;
  /** Only for read-only range widgets (slider, progressbar, meter, scrollbar). Never for text inputs. */
  value?: string;
}

export interface AccessibilitySnapshot {
  nodes: AxNode[];
  /** Indented text outline (`- role "name" [props]`), compact enough to hand to an agent. */
  outline: string;
  totalNodes: number;
  truncated: boolean;
}

/** Structural or text-run roles that add noise without meaning. Their children are re-parented. */
const PRUNED = new Set(['generic', 'none', 'presentation', 'StaticText', 'InlineTextBox', 'LineBreak', 'ListMarker']);
/**
 * Chromium reports typed text as `value` for textboxes (and masked bullets for passwords, which still leak length).
 * Values are therefore dropped for everything except read-only range widgets.
 */
const VALUE_ROLES = new Set(['slider', 'progressbar', 'meter', 'scrollbar']);

export function fetchRawAxTree(page: Page): Promise<RawAxNode[]> {
  return withCdp(page, async (cdp) => (await cdp.send('Accessibility.getFullAXTree')).nodes as RawAxNode[]);
}

export function prop(node: RawAxNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

export function roleOf(n: RawAxNode): string {
  return String(n.role?.value ?? '');
}

export function nameOf(n: RawAxNode): string {
  return String(n.name?.value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildAccessibilitySnapshot(raw: RawAxNode[], opts: { maxNodes?: number } = {}): AccessibilitySnapshot {
  const maxNodes = opts.maxNodes ?? 5_000;
  const byId = new Map(raw.map((n) => [n.nodeId, n]));
  const kept = (n: RawAxNode) => !n.ignored && !PRUNED.has(roleOf(n));
  const keptAncestor = (n: RawAxNode): string | null => {
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    while (p && !kept(p)) p = p.parentId ? byId.get(p.parentId) : undefined;
    return p?.nodeId ?? null;
  };

  const nodes: AxNode[] = [];
  let truncated = false;
  // Document order: walk from the root via childIds.
  const root = raw.find((n) => !n.parentId);
  const stack = root ? [root] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (kept(n)) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      nodes.push(toAxNode(n, keptAncestor(n)));
    }
    const kids = (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is RawAxNode => !!c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return { nodes, outline: outline(nodes), totalNodes: raw.length, truncated };
}

function toAxNode(n: RawAxNode, parentId: string | null): AxNode {
  const role = roleOf(n);
  const out: AxNode = { id: n.nodeId, parentId, role, name: redactText(nameOf(n)) };
  const level = prop(n, 'level');
  if (typeof level === 'number') out.level = level;
  const expanded = prop(n, 'expanded');
  if (typeof expanded === 'boolean') out.expanded = expanded;
  const checked = prop(n, 'checked');
  if (checked !== undefined && checked !== 'false') out.checked = String(checked);
  if (prop(n, 'selected') === true) out.selected = true;
  if (prop(n, 'disabled') === true) out.disabled = true;
  if (prop(n, 'focusable') === true) out.focusable = true;
  if (prop(n, 'required') === true) out.required = true;
  const popup = prop(n, 'hasPopup');
  if (typeof popup === 'string' && popup !== 'false') out.hasPopup = popup;
  const url = prop(n, 'url');
  if (typeof url === 'string' && url) out.url = redactUrl(url);
  if (VALUE_ROLES.has(role) && n.value?.value !== undefined) out.value = String(n.value.value);
  return out;
}

function outline(nodes: AxNode[]): string {
  const depth = new Map<string, number>();
  const lines: string[] = [];
  for (const n of nodes) {
    const d = n.parentId === null ? 0 : (depth.get(n.parentId) ?? -1) + 1;
    depth.set(n.id, d);
    if (n.role === 'RootWebArea') continue;
    const flags: string[] = [];
    if (n.level !== undefined) flags.push(`level=${n.level}`);
    if (n.expanded !== undefined) flags.push(`expanded=${n.expanded}`);
    if (n.checked) flags.push(`checked=${n.checked}`);
    if (n.disabled) flags.push('disabled');
    if (n.url) flags.push(`url=${n.url}`);
    const name = n.name ? ` ${JSON.stringify(n.name)}` : '';
    lines.push(`${'  '.repeat(Math.max(0, d - 1))}- ${n.role}${name}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
  }
  return lines.join('\n');
}
