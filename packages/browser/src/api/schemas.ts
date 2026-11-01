import { z } from 'zod';
import { ProjectIdSchema, ViewportSchema } from '../schemas.ts';

/** HTTP request schemas. All are strict: unknown fields are rejected, not ignored. */

const WaitUntil = z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']);
const Timeout = z.number().int().min(1_000).max(300_000);

export const EmptyBody = z.strictObject({});

export const CreateProfileBody = z.object({ projectId: ProjectIdSchema, displayName: z.string().trim().min(1).max(120).optional() }).strict();

export const OpenPageBody = z
  .object({ url: z.string().min(1).max(8_192).optional(), waitUntil: WaitUntil.optional(), timeoutMs: Timeout.optional(), retries: z.number().int().min(0).max(5).optional() })
  .strict();

export const HistoryNavBody = z.object({ waitUntil: WaitUntil.optional(), timeoutMs: Timeout.optional() }).strict();

export const ScreenshotBody = z
  .object({
    mode: z.enum(['viewport', 'full_page']).default('viewport'),
    viewport: ViewportSchema.optional(),
    maxFullPageHeight: z.number().int().min(1_000).max(100_000).optional(),
  })
  .strict();

export const StabilityBody = z.object({
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  quietMs: z.number().int().min(50).max(10_000).optional(),
  longRequestMs: z.number().int().min(500).max(120_000).optional(),
}).strict();

export const InspectBody = z
  .object({
    settle: z.union([z.boolean(), StabilityBody]).optional(),
    screenshot: z.enum(['viewport', 'full_page', 'none']).optional(),
    screenshotViewport: ViewportSchema.optional(),
    include: z.object({ dom: z.boolean(), accessibility: z.boolean(), interactive: z.boolean(), network: z.boolean() }).partial().strict().optional(),
    dom: z.object({ maxNodes: z.number().int().min(1).max(50_000), maxTextLength: z.number().int().min(0).max(5_000) }).partial().strict().optional(),
    maxAccessibilityNodes: z.number().int().min(1).max(50_000).optional(),
    maxInteractiveElements: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

const intParam = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const DomQuery = z.object({ maxNodes: intParam(1, 50_000).optional(), maxTextLength: intParam(0, 5_000).optional() }).strict();
export const AxQuery = z.object({ maxNodes: intParam(1, 50_000).optional() }).strict();
export const InteractiveQuery = z.object({ maxElements: intParam(1, 10_000).optional() }).strict();
export const HistoryQuery = z.object({ sinceSeq: intParam(0, Number.MAX_SAFE_INTEGER).optional() }).strict();
export const NetworkQuerySchema = z
  .object({
    pageId: z.string().regex(/^pg_[a-f0-9]{16}$/).optional(),
    sinceSeq: intParam(0, Number.MAX_SAFE_INTEGER).optional(),
    failedOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    resourceTypes: z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)).optional(),
    limit: intParam(1, 5_000).optional(),
  })
  .strict();

/** Drop keys whose value is undefined (zod output keeps them; exactOptionalPropertyTypes rejects them). */
export function defined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

export function queryObject(q: URLSearchParams): Record<string, string> {
  return Object.fromEntries(q.entries());
}
