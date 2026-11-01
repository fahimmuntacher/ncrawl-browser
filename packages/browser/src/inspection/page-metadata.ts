import type { Page } from 'playwright';
import { redactText, redactUrl } from '../redaction.ts';

export interface PageMetadata {
  url: string;
  title: string;
  lang: string | null;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  readyState: string;
  /** Visible text summary (headings and size), not the full text. */
  text: { wordCount: number; headings: { level: number; text: string }[] };
  /**
   * An element other than the document scrolls (e.g. a fixed-height app shell with a scrolling <main>).
   * Full-page screenshots then only show that element's visible part.
   */
  innerScrollContainers: number;
}

export async function collectPageMetadata(page: Page): Promise<PageMetadata> {
  const raw = await page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .filter((h) => (h as HTMLElement).checkVisibility?.() ?? true)
      .slice(0, 50)
      .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
    const text = body?.innerText ?? '';
    let inner = 0;
    for (const el of document.querySelectorAll('body *')) {
      const e = el as HTMLElement;
      if (e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 100) {
        const oy = getComputedStyle(e).overflowY;
        if (oy === 'auto' || oy === 'scroll') inner++;
      }
      if (inner >= 20) break;
    }
    return {
      title: document.title,
      lang: de.lang || null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        width: Math.max(de.scrollWidth, body?.scrollWidth ?? 0),
        height: Math.max(de.scrollHeight, body?.scrollHeight ?? 0),
      },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      devicePixelRatio: window.devicePixelRatio,
      readyState: document.readyState,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      headings,
      inner,
    };
  });
  return {
    url: redactUrl(page.url()),
    title: raw.title,
    lang: raw.lang,
    viewport: raw.viewport,
    document: raw.document,
    scroll: raw.scroll,
    devicePixelRatio: raw.devicePixelRatio,
    readyState: raw.readyState,
    text: { wordCount: raw.wordCount, headings: raw.headings.map((h) => ({ ...h, text: redactText(h.text) })) },
    innerScrollContainers: raw.inner,
  };
}
