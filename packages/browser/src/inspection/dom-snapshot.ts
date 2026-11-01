import type { Page } from 'playwright';
import { redactText, redactUrl } from '../redaction.ts';

export interface DomNode {
  /** Index in `nodes`; `parent` is the parent's index (-1 for the root). */
  i: number;
  parent: number;
  tag: string;
  attrs?: Record<string, string>;
  /** Own text (direct text children), whitespace-collapsed and truncated. Never form-field values. */
  text?: string;
  visible: boolean;
  /** [x, y, width, height] in document coordinates, for visible elements. */
  rect?: [number, number, number, number];
  /** Children came from an open shadow root. */
  shadow?: boolean;
}

export interface DomSnapshot {
  nodes: DomNode[];
  totalElements: number;
  truncated: boolean;
  /** Frames are not traversed; their URLs are listed. */
  frames: string[];
}

export interface DomSnapshotOptions {
  maxNodes?: number;
  maxTextLength?: number;
}

/**
 * A bounded, structure-preserving DOM snapshot.
 * Privacy rules (enforced in the page, before data leaves it):
 *  - attribute allow-list only: never `value`, `style`, event handlers, or arbitrary data-* attributes;
 *  - no text from <textarea>, <input>, <select> state, <script>, <style>, <template>, <noscript>;
 *  - <head> is skipped (meta tags often carry CSRF tokens).
 */
export async function collectDomSnapshot(page: Page, opts: DomSnapshotOptions = {}): Promise<DomSnapshot> {
  const snap = await page.evaluate(
    ({ maxNodes, maxText }) => {
      const ALLOWED = new Set([
        'id', 'class', 'role', 'href', 'src', 'alt', 'title', 'name', 'type', 'placeholder', 'for', 'target', 'rel',
        'action', 'method', 'disabled', 'checked', 'selected', 'hidden', 'tabindex', 'contenteditable', 'lang',
        'data-testid', 'data-test', 'data-cy', 'colspan', 'rowspan', 'open',
      ]);
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META']);
      const NO_TEXT = new Set(['TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
      const nodes: any[] = [];
      const frames: string[] = [];
      let total = 0;
      let truncated = false;
      const sx = window.scrollX;
      const sy = window.scrollY;

      const visit = (el: Element, parent: number, shadow: boolean) => {
        total++;
        if (SKIP.has(el.tagName)) return;
        if (nodes.length >= maxNodes) {
          truncated = true;
          return;
        }
        const i = nodes.length;
        const node: any = { i, parent, tag: el.tagName.toLowerCase(), visible: false };
        if (shadow) node.shadow = true;
        const attrs: Record<string, string> = {};
        for (const a of el.attributes) {
          if (ALLOWED.has(a.name) || (a.name.startsWith('aria-') && a.name !== 'aria-valuetext')) {
            attrs[a.name] = a.name === 'class' ? a.value.slice(0, 200) : a.value.slice(0, 2000);
          }
        }
        if (attrs.src?.startsWith('data:')) attrs.src = 'data:[omitted]';
        if (Object.keys(attrs).length) node.attrs = attrs;
        if (!NO_TEXT.has(el.tagName)) {
          let t = '';
          for (const c of el.childNodes) if (c.nodeType === 3) t += c.nodeValue;
          t = t.replace(/\s+/g, ' ').trim();
          if (t) node.text = t.length > maxText ? t.slice(0, maxText) + '…' : t;
        }
        const visible = (el as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true;
        if (visible) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            node.visible = true;
            node.rect = [Math.round(r.x + sx), Math.round(r.y + sy), Math.round(r.width), Math.round(r.height)];
          }
        }
        nodes.push(node);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          frames.push((el as HTMLIFrameElement).src);
          return;
        }
        if (el.tagName === 'svg') return; // keep the icon, skip its paths
        if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c, i, true);
        for (const c of el.children) visit(c, i, shadow);
      };
      if (document.body) visit(document.body, -1, false);
      return { nodes, totalElements: total, truncated, frames };
    },
    { maxNodes: opts.maxNodes ?? 5_000, maxText: opts.maxTextLength ?? 200 },
  );

  for (const n of snap.nodes as DomNode[]) {
    if (n.attrs) {
      for (const k of ['href', 'src', 'action'] as const) {
        if (n.attrs[k]) n.attrs[k] = redactUrl(absolute(n.attrs[k], page.url()));
      }
    }
    if (n.text) n.text = redactText(n.text);
  }
  return { ...snap, frames: snap.frames.map((f) => redactUrl(f)) } as DomSnapshot;
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
