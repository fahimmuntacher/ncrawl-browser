import { createHash } from 'node:crypto';
import type { CDPSession, Page } from 'playwright';
import { redactText, redactUrl } from '../redaction.ts';
import { nameOf, prop, roleOf, type RawAxNode } from './accessibility.ts';
import { withCdp } from './cdp.ts';

export type Region = 'breadcrumb' | 'sidebar' | 'header' | 'footer' | 'navigation' | 'main' | 'other';

/**
 * How safe it is for an automated crawler to activate this element. Only `safe` may be clicked without the user;
 * everything else needs explicit approval or must never be automated.
 */
export type Risk = 'safe' | 'external' | 'input' | 'form-submit' | 'mutating' | 'logout' | 'unknown-action';

export interface InteractiveElement {
  /** Stable across reloads while role, label, landmark, menu path and URL path stay the same. */
  elementId: string;
  role: string;
  name: string;
  /** Name without decorative glyphs (e.g. "▸ HR" -> "HR"). */
  label: string;
  tag: string | null;
  href: string | null;
  sameOrigin: boolean | null;
  region: Region;
  landmark: { role: string; name: string } | null;
  /** Labels of the enclosing expandable menu groups, outermost first. */
  menuPath: string[];
  expanded?: boolean;
  disabled?: boolean;
  visible: boolean;
  /** [x, y, width, height] in document coordinates. */
  rect: [number, number, number, number] | null;
  risk: Risk;
  riskReasons: string[];
  /**
   * How to find the element again with Playwright.
   * Preferred: page.getByRole(role, { name: new RegExp(namePattern) }).nth(patternNth)
   *   — whitespace-insensitive, because Chromium's accessible name and Playwright's can differ in whitespace
   *   (e.g. server-rendered React text split by comment nodes: "▸Inventory" vs "▸ Inventory").
   * Also: page.getByRole(role, { name, exact: true }).nth(nth), or page.getByTestId(testId).
   */
  locator: { role: string | null; name: string; exact: true; nth: number; namePattern: string; patternNth: number; testId?: string };
}

export interface NavigationLink {
  elementId: string;
  label: string;
  url: string;
  /** Fragment removed (unless it is a hash route), utm_* removed, query sorted, trailing slash trimmed. */
  normalizedUrl: string;
  sameOrigin: boolean;
  region: Region;
  menuPath: string[];
  depth: number;
  visible: boolean;
  /** Why a crawler should not follow it automatically (null = candidate). */
  excluded: null | 'logout' | 'external' | 'self';
}

export interface ExpandableGroup {
  elementId: string;
  label: string;
  expanded: boolean;
  region: Region;
  menuPath: string[];
  risk: Risk;
}

export interface InteractiveResult {
  elements: InteractiveElement[];
  navigationLinks: NavigationLink[];
  expandableGroups: ExpandableGroup[];
  truncated: boolean;
}

const INTERACTIVE = new Set([
  'link', 'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch',
  'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'treeitem', 'DisclosureTriangle',
]);
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const LANDMARKS = new Set(['banner', 'navigation', 'complementary', 'main', 'contentinfo', 'search', 'form', 'region']);
const LOGOUT = /\b(log\s?out|sign\s?out|log\s?off|sign\s?off)\b/i;
const LOGOUT_URL = /\/(logout|log-out|signout|sign-out|logoff)\b/i;
const MUTATING = /\b(delete|remove|destroy|erase|purge|drop|terminate|revoke|reset|deactivate|disable|archive|cancel|refund|pay|purchase|buy|checkout|order|transfer|withdraw|approve|reject|decline|send|publish|submit|confirm|save|update|edit|create|add|new|upload|import|sync|run|execute|deploy|invite|assign|post|share)\b/i;

export async function collectInteractive(page: Page, raw: RawAxNode[], opts: { maxElements?: number } = {}): Promise<InteractiveResult> {
  const maxElements = opts.maxElements ?? 1_000;
  const pageUrl = page.url();
  const origin = safeOrigin(pageUrl);
  const byId = new Map(raw.map((n) => [n.nodeId, n]));
  const ancestors = (n: RawAxNode): RawAxNode[] => {
    const out: RawAxNode[] = [];
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    while (p) {
      out.push(p);
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return out;
  };

  // Document order.
  const ordered: RawAxNode[] = [];
  const root = raw.find((n) => !n.parentId);
  const stack = root ? [root] : [];
  while (stack.length) {
    const n = stack.pop()!;
    ordered.push(n);
    const kids = (n.childIds ?? []).map((id) => byId.get(id)).filter((c): c is RawAxNode => !!c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  const candidates = ordered.filter((n) => !n.ignored && INTERACTIVE.has(roleOf(n)) && n.backendDOMNodeId !== undefined);
  const truncated = candidates.length > maxElements;
  const selected = candidates.slice(0, maxElements);

  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const domFacts = await withCdp(page, (cdp) => Promise.all(selected.map((n) => describe(cdp, n.backendDOMNodeId!))));

  const roleNameCount = new Map<string, number>();
  const rolePatternCount = new Map<string, number>();
  const keyCount = new Map<string, number>();
  const elements: InteractiveElement[] = [];

  selected.forEach((n, idx) => {
    const facts = domFacts[idx]!;
    const role = roleOf(n);
    const name = redactText(nameOf(n));
    const label = cleanLabel(name);
    const anc = ancestors(n);
    const landmarkNode = anc.find((a) => !a.ignored && LANDMARKS.has(roleOf(a)));
    const landmark = landmarkNode ? { role: roleOf(landmarkNode), name: nameOf(landmarkNode) } : null;
    const region = regionOf(anc);
    const menuPath = menuPathOf(n, anc, byId);
    const rawHref = (prop(n, 'url') as string | undefined) || facts.href;
    const absHref = rawHref ? absolute(rawHref, pageUrl) : null;
    const href = absHref ? redactUrl(absHref) : null;
    const sameOrigin = absHref ? safeOrigin(absHref) === origin : null;
    const expanded = prop(n, 'expanded');
    const disabled = prop(n, 'disabled') === true;
    const { risk, reasons } = classify(role, label, absHref, sameOrigin, typeof expanded === 'boolean', facts);

    const rn = `${role}\u0000${name}`;
    const nth = roleNameCount.get(rn) ?? 0;
    roleNameCount.set(rn, nth + 1);
    const compact = name.replace(/\s+/g, '');
    const rp = `${role}\u0000${compact}`;
    const patternNth = rolePatternCount.get(rp) ?? 0;
    rolePatternCount.set(rp, patternNth + 1);
    const pathPart = absHref ? safePath(absHref) : '';
    const key = [role, label, landmark?.role ?? '', landmark?.name ?? '', menuPath.join('>'), pathPart].join('\u0000');
    const ordinal = keyCount.get(key) ?? 0;
    keyCount.set(key, ordinal + 1);

    elements.push({
      elementId: 'el_' + createHash('sha256').update(`${key}\u0000${ordinal}`).digest('hex').slice(0, 12),
      role,
      name,
      label,
      tag: facts.tag,
      href,
      sameOrigin,
      region,
      landmark,
      menuPath,
      ...(typeof expanded === 'boolean' ? { expanded } : {}),
      ...(disabled ? { disabled } : {}),
      visible: facts.rect !== null,
      rect: facts.rect ? [facts.rect[0] + Math.round(scroll.x), facts.rect[1] + Math.round(scroll.y), facts.rect[2], facts.rect[3]] : null,
      risk,
      riskReasons: reasons,
      locator: {
        role: /^[a-z]+$/.test(role) ? role : null,
        name,
        exact: true,
        nth,
        namePattern: whitespaceInsensitivePattern(compact),
        patternNth,
        ...(facts.testId ? { testId: facts.testId } : {}),
      },
    });
  });

  const navigationLinks: NavigationLink[] = elements
    .filter((e) => e.role === 'link' && e.href && /^https?:/i.test(e.href))
    .map((e) => {
      const normalizedUrl = normalizeUrl(e.href!);
      return {
        elementId: e.elementId,
        label: e.label,
        url: e.href!,
        normalizedUrl,
        sameOrigin: e.sameOrigin === true,
        region: e.region,
        menuPath: e.menuPath,
        depth: e.menuPath.length,
        visible: e.visible,
        excluded: e.risk === 'logout' ? 'logout' : e.sameOrigin ? (normalizedUrl === normalizeUrl(redactUrl(pageUrl)) ? 'self' : null) : 'external',
      };
    });

  const expandableGroups: ExpandableGroup[] = elements
    .filter((e) => e.expanded !== undefined && e.role !== 'link' && e.role !== 'combobox')
    .map((e) => ({ elementId: e.elementId, label: e.label, expanded: e.expanded!, region: e.region, menuPath: e.menuPath, risk: e.risk }));

  return { elements, navigationLinks, expandableGroups, truncated };
}

interface DomFacts {
  tag: string | null;
  href: string | null;
  testId: string | null;
  rect: [number, number, number, number] | null;
  /** true if activating it submits a <form>. */
  submitsForm: boolean;
  type: string | null;
}

async function describe(cdp: CDPSession, backendNodeId: number): Promise<DomFacts> {
  const facts: DomFacts = { tag: null, href: null, testId: null, rect: null, submitsForm: false, type: null };
  try {
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
    facts.tag = node.nodeName.toLowerCase();
    const attrs = new Map<string, string>();
    for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2) attrs.set(node.attributes![i]!, node.attributes![i + 1]!);
    facts.href = attrs.get('href') ?? null;
    facts.testId = attrs.get('data-testid') ?? attrs.get('data-test') ?? attrs.get('data-cy') ?? null;
    facts.type = attrs.get('type')?.toLowerCase() ?? null;
  } catch {
    return facts;
  }
  try {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
    const q = model.border;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w > 0 && h > 0) facts.rect = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
  } catch {
    // Not rendered (display:none, collapsed, detached).
  }
  if (facts.tag === 'button' || facts.tag === 'input') {
    try {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
      if (object.objectId) {
        const { result } = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function () { return !!this.form && (this.type === "submit" || this.type === "image"); }',
          returnByValue: true,
        });
        facts.submitsForm = result.value === true;
        await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      }
    } catch {
      facts.submitsForm = false;
    }
  }
  return facts;
}

function classify(role: string, label: string, href: string | null, sameOrigin: boolean | null, isToggle: boolean, facts: DomFacts): { risk: Risk; reasons: string[] } {
  if (LOGOUT.test(label) || (href && LOGOUT_URL.test(safePath(href)))) return { risk: 'logout', reasons: ['ends the session'] };
  if (INPUT_ROLES.has(role)) return { risk: 'input', reasons: ['changes form or page state when used'] };
  if (facts.submitsForm) return { risk: 'form-submit', reasons: ['submits a form'] };
  const word = label.match(MUTATING)?.[0];
  if (role === 'link') {
    if (!href) return { risk: 'unknown-action', reasons: ['link without a URL (script-driven)'] };
    if (!/^https?:/i.test(href)) return { risk: 'external', reasons: [`non-web link (${href.split(':')[0]}:)`] };
    if (sameOrigin === false) return { risk: 'external', reasons: ['different origin'] };
    if (word) return { risk: 'mutating', reasons: [`label suggests an action: "${word}"`] };
    return { risk: 'safe', reasons: ['same-origin link'] };
  }
  if (word) return { risk: 'mutating', reasons: [`label suggests an action: "${word}"`] };
  if (isToggle || role === 'tab' || role === 'treeitem' || role === 'DisclosureTriangle') {
    return { risk: 'safe', reasons: ['disclosure / tab control'] };
  }
  return { risk: 'unknown-action', reasons: ['button with unknown effect'] };
}

function regionOf(anc: RawAxNode[]): Region {
  const roles = anc.filter((a) => !a.ignored).map((a) => ({ role: roleOf(a), name: nameOf(a) }));
  if (roles.some((r) => r.role === 'navigation' && /bread\s?crumb/i.test(r.name))) return 'breadcrumb';
  if (roles.some((r) => r.role === 'complementary')) return 'sidebar';
  if (roles.some((r) => r.role === 'banner')) return 'header';
  if (roles.some((r) => r.role === 'contentinfo')) return 'footer';
  if (roles.some((r) => r.role === 'navigation')) return 'navigation';
  if (roles.some((r) => r.role === 'main')) return 'main';
  return 'other';
}

/**
 * Labels of the disclosure controls whose content contains this element, outermost first.
 *  1. An ancestor that itself has an `expanded` state (tree/menu item pattern).
 *  2. A control whose aria-controls target is one of the element's ancestors (Chromium resolves the IDs).
 *  3. Fallback for controls without aria-controls: the control immediately before the ancestor branch
 *     that holds the element. Never just "any sibling" — sibling submenus would be misattributed.
 */
function menuPathOf(n: RawAxNode, anc: RawAxNode[], byId: Map<string, RawAxNode>): string[] {
  const path: string[] = [];
  const chainNodes = [n, ...anc];
  const chainBackend = new Set(chainNodes.map((c) => c.backendDOMNodeId).filter((b): b is number => b !== undefined));
  for (let i = 0; i < anc.length; i++) {
    const a = anc[i]!;
    const branch = chainNodes[i]!; // the child of `a` on the way down to the element
    if (typeof prop(a, 'expanded') === 'boolean' && !a.ignored && roleOf(a) !== 'combobox') {
      path.push(cleanLabel(nameOf(a)));
    } else {
      const kids = (a.childIds ?? []).map((id) => byId.get(id)).filter((c): c is RawAxNode => !!c && !c.ignored);
      const isToggle = (c: RawAxNode) => c !== branch && typeof prop(c, 'expanded') === 'boolean' && roleOf(c) !== 'combobox';
      let owner = kids.find((c) => isToggle(c) && controlledBackendIds(c).some((b) => chainBackend.has(b)));
      if (!owner) {
        const prev = kids[kids.indexOf(branch) - 1];
        if (prev && isToggle(prev) && controlledBackendIds(prev).length === 0) owner = prev;
      }
      if (owner) path.push(cleanLabel(nameOf(owner)));
    }
    if (LANDMARKS.has(roleOf(a))) break;
  }
  return path.reverse().filter(Boolean);
}

function controlledBackendIds(n: RawAxNode): number[] {
  const p = n.properties?.find((x) => x.name === 'controls')?.value as { relatedNodes?: { backendDOMNodeId?: number }[] } | undefined;
  return (p?.relatedNodes ?? []).map((r) => r.backendDOMNodeId).filter((b): b is number => b !== undefined);
}

/** Anchored regex source matching `compact` with any whitespace between characters. */
export function whitespaceInsensitivePattern(compact: string): string {
  const chars = Array.from(compact).map((c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return `^\\s*${chars.join('\\s*')}\\s*$`;
}

export function cleanLabel(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N})\]]+$/u, '').trim();
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!(u.hash.startsWith('#/') || u.hash.startsWith('#!'))) u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}
