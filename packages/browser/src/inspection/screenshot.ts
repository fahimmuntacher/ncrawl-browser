import path from 'node:path';
import type { Page } from 'playwright';
import { NcrawlError } from '../errors.ts';
import type { HistoryRecorder } from '../observers/history-recorder.ts';
import { redactUrl } from '../redaction.ts';
import { pngSize, type CaptureStore } from '../storage/capture-store.ts';

export type CaptureMode = 'viewport' | 'full_page';

export interface ScreenshotOptions {
  mode?: CaptureMode;
  /** Temporarily resize the viewport for this capture; restored afterwards. */
  viewport?: { width: number; height: number };
  /** Full-page captures taller than this fall back to a viewport capture (Chromium texture limits). */
  maxFullPageHeight?: number;
  timeoutMs?: number;
}

export interface ScreenshotInfo {
  captureId: string;
  seq: number;
  /** Path relative to the capture root (safe to show; no absolute paths in API output). */
  file: string;
  mode: CaptureMode;
  /** What was asked for vs. what was produced (they differ only on fallback). */
  requestedMode: CaptureMode;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  capturedAt: string;
  /** History position at capture time: ties the image to a navigation event. */
  historySeq: number;
  /**
   * ok: page did not navigate during capture.
   * unstable: URL or history changed while capturing — the image may not match `url`.
   * fallback: full-page was requested but a viewport capture was produced (see notes).
   */
  status: 'ok' | 'unstable' | 'fallback';
  notes: string[];
}

export async function captureScreenshot(
  page: Page,
  store: CaptureStore,
  target: { projectId: string | null; sessionId: string; history: HistoryRecorder },
  opts: ScreenshotOptions = {},
): Promise<ScreenshotInfo> {
  const requestedMode = opts.mode ?? 'viewport';
  const maxH = opts.maxFullPageHeight ?? 30_000;
  const notes: string[] = [];
  const originalViewport = page.viewportSize();
  if (opts.viewport) await page.setViewportSize(opts.viewport);

  try {
    const urlBefore = page.url();
    const historyBefore = target.history.lastSeq;
    const dims = await page.evaluate(() => ({
      h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      title: document.title,
    }));
    let mode = requestedMode;
    if (mode === 'full_page' && dims.h > maxH) {
      mode = 'viewport';
      notes.push(`document height ${dims.h}px exceeds ${maxH}px; captured the viewport instead`);
    }

    let png: Buffer;
    try {
      png = await page.screenshot({
        fullPage: mode === 'full_page',
        animations: 'disabled',
        caret: 'hide',
        timeout: opts.timeoutMs ?? 30_000,
      });
    } catch (e) {
      throw new NcrawlError('CAPTURE_FAILED', `Screenshot failed: ${(e as Error).message.split('\n')[0]}`, { cause: e, retryable: true });
    }

    const urlAfter = page.url();
    const historyAfter = target.history.lastSeq;
    let status: ScreenshotInfo['status'] = mode === requestedMode ? 'ok' : 'fallback';
    if (urlAfter !== urlBefore || historyAfter !== historyBefore) {
      status = 'unstable';
      notes.push('the page navigated during capture; the image may show a different page');
    }

    const size = pngSize(png);
    const capturedAt = new Date().toISOString();
    const slot = await store.allocate(target.projectId, target.sessionId, urlBefore);
    const written = await store.writeFile(slot.dir, `${slot.base}.png`, png);
    const viewport = page.viewportSize() ?? { width: size.width, height: size.height };
    const info: ScreenshotInfo = {
      captureId: slot.captureId,
      seq: slot.seq,
      file: path.relative(store.root, written.path),
      mode,
      requestedMode,
      width: size.width,
      height: size.height,
      bytes: written.bytes,
      sha256: written.sha256,
      url: redactUrl(urlBefore),
      title: dims.title,
      viewport,
      capturedAt,
      historySeq: historyBefore,
      status,
      notes,
    };
    await store.writeFile(slot.dir, `${slot.base}.screenshot.json`, JSON.stringify(info, null, 2) + '\n');
    return info;
  } finally {
    if (opts.viewport && originalViewport) await page.setViewportSize(originalViewport).catch(() => {});
  }
}
