import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PageObservation } from '../inspection/inspector.ts';
import { normalizeUrl } from '../inspection/interactive.ts';

/**
 * Sync contracts: the records NCrawl hands to the FastAPI backend / PostgreSQL (PRD "Suggested data model").
 * snake_case on purpose — these mirror database columns and Pydantic models, not the camelCase browser API.
 * The backend receives these payloads; it never drives a browser and never receives cookies (ADR 0001).
 */

const uuid = z.uuid();
const iso = z.iso.datetime();

export const ProjectSchema = z.strictObject({
  id: uuid,
  name: z.string().min(1).max(200),
  origin: z.url(),
  created_at: iso,
  updated_at: iso,
});

export const CrawlSessionStatus = z.enum(['queued', 'discovering', 'review_required', 'crawling', 'paused', 'completed', 'partial', 'failed', 'cancelled']);
export const CrawlSessionSchema = z.strictObject({
  id: uuid,
  project_id: uuid,
  status: CrawlSessionStatus,
  started_at: iso.nullable(),
  completed_at: iso.nullable(),
  settings_json: z.record(z.string(), z.unknown()),
  discovered_count: z.number().int().min(0),
  captured_count: z.number().int().min(0),
  failed_count: z.number().int().min(0),
  skipped_count: z.number().int().min(0),
});

export const PageNodeStatus = z.enum(['discovered', 'queued', 'capturing', 'captured', 'failed', 'skipped']);
export const PageNodeSchema = z.strictObject({
  id: uuid,
  session_id: uuid,
  normalized_url: z.string(),
  original_url: z.string(),
  title: z.string(),
  nav_label: z.string().nullable(),
  /** Extension to the PRD model: menu labels down to this page, e.g. ["HR", "Payroll", "Payslips"]. */
  nav_path: z.array(z.string()),
  /** Extension: first nav_path entry, for module grouping on the sitemap (FR-04). */
  module: z.string().nullable(),
  parent_node_id: uuid.nullable(),
  source_node_id: uuid.nullable(),
  depth: z.number().int().min(0),
  status: PageNodeStatus,
  /** Local capture-store path of the screenshot (never uploaded unless sync of images is opted in). */
  screenshot_ref: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  capture_method: z.enum(['viewport', 'full_page', 'stitched']).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  discovered_at: iso,
  captured_at: iso.nullable(),
  position_x: z.number().nullable(),
  position_y: z.number().nullable(),
});

export const NavigationEdgeSchema = z.strictObject({
  id: uuid,
  session_id: uuid,
  source_node_id: uuid,
  target_node_id: uuid,
  label: z.string().nullable(),
  interaction_type: z.enum(['link', 'menu', 'manual']),
  observed_at: iso,
});

/** Bodies of POST /api/v1/sessions/{id}/nodes/bulk and /edges/bulk (PRD API outline). Upsert by `id`. */
export const NodesBulkSchema = z.strictObject({ nodes: z.array(PageNodeSchema).max(1_000) });
export const EdgesBulkSchema = z.strictObject({ edges: z.array(NavigationEdgeSchema).max(5_000) });

/** manifest.json inside an export ZIP (PRD FR-05). Never contains cookies, tokens or credentials. */
export const ExportManifestSchema = z.strictObject({
  manifest_version: z.literal(1),
  session_id: uuid,
  origin: z.string(),
  created_at: iso,
  pages: z.array(z.strictObject({
    node_id: uuid,
    url: z.string(),
    title: z.string(),
    parent_node_id: uuid.nullable(),
    source_node_id: uuid.nullable(),
    depth: z.number().int().min(0),
    status: PageNodeStatus,
    image_filename: z.string().nullable(),
    errors: z.array(z.strictObject({ code: z.string(), message: z.string() })),
  })),
});

export type Project = z.output<typeof ProjectSchema>;
export type CrawlSession = z.output<typeof CrawlSessionSchema>;
export type PageNode = z.output<typeof PageNodeSchema>;
export type NavigationEdge = z.output<typeof NavigationEdgeSchema>;
export type ExportManifest = z.output<typeof ExportManifestSchema>;

export const NAMED_SYNC_SCHEMAS = {
  Project: ProjectSchema,
  CrawlSession: CrawlSessionSchema,
  PageNode: PageNodeSchema,
  NavigationEdge: NavigationEdgeSchema,
  NodesBulk: NodesBulkSchema,
  EdgesBulk: EdgesBulkSchema,
  ExportManifest: ExportManifestSchema,
} as const;

// --------------------------------------------------------------------- IDs

/** Fixed namespace for NCrawl name-based UUIDs. Never change it: IDs of synced records depend on it. */
export const NCRAWL_UUID_NAMESPACE = '4f1c2a8e-6b3d-5e7f-9a0b-1c2d3e4f5a6b';

/** RFC 4122 version-5 UUID: the same inputs always give the same ID, so re-syncing upserts instead of duplicating. */
export function uuidV5(name: string, namespace = NCRAWL_UUID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const pageNodeId = (crawlSessionId: string, normalizedUrl: string) => uuidV5(`node:${crawlSessionId}:${normalizedUrl}`);
export const edgeId = (crawlSessionId: string, sourceNodeId: string, targetNodeId: string) => uuidV5(`edge:${crawlSessionId}:${sourceNodeId}:${targetNodeId}`);

// --------------------------------------------------------------------- mapping

export interface PageNodeContext {
  /** The crawl session (backend UUID), not the browser session ID. */
  crawlSessionId: string;
  depth: number;
  parentNodeId?: string | null;
  sourceNodeId?: string | null;
  navLabel?: string | null;
  navPath?: string[];
  discoveredAt?: string;
}

/** Turn one page observation into a PageNode record. */
export function toPageNode(obs: PageObservation, ctx: PageNodeContext): PageNode {
  const url = obs.metadata?.url ?? obs.screenshot?.url ?? '';
  const normalized = normalizeUrl(url);
  const navPath = ctx.navPath ?? [];
  const firstError = obs.errors[0];
  return PageNodeSchema.parse({
    id: pageNodeId(ctx.crawlSessionId, normalized),
    session_id: ctx.crawlSessionId,
    normalized_url: normalized,
    original_url: url,
    title: obs.metadata?.title ?? obs.screenshot?.title ?? '',
    nav_label: ctx.navLabel ?? null,
    nav_path: navPath,
    module: navPath[0] ?? null,
    parent_node_id: ctx.parentNodeId ?? null,
    source_node_id: ctx.sourceNodeId ?? null,
    depth: ctx.depth,
    status: obs.status === 'failed' ? 'failed' : 'captured',
    screenshot_ref: obs.screenshot?.file ?? null,
    width: obs.screenshot?.width ?? null,
    height: obs.screenshot?.height ?? null,
    capture_method: obs.screenshot?.mode ?? null,
    error_code: firstError?.code ?? null,
    error_message: firstError?.message ?? null,
    discovered_at: ctx.discoveredAt ?? obs.startedAt,
    captured_at: obs.status === 'failed' ? null : obs.completedAt,
    position_x: null,
    position_y: null,
  });
}

/**
 * Observed navigation edges: an edge source→target exists when the source page's observation contains a
 * navigation link (not excluded: no logout/external/self) whose normalized URL is the target node's.
 * Links in sidebars, headers, nav landmarks or menus are `menu`; others are `link`. Nothing is inferred.
 */
export function deriveEdges(crawlSessionId: string, pages: readonly { node: PageNode; observation: PageObservation }[]): NavigationEdge[] {
  const byUrl = new Map(pages.map((p) => [p.node.normalized_url, p.node]));
  const edges = new Map<string, NavigationEdge>();
  for (const { node: source, observation } of pages) {
    for (const link of observation.navigationLinks ?? []) {
      if (link.excluded !== null || !link.sameOrigin) continue;
      const target = byUrl.get(link.normalizedUrl);
      if (!target || target.id === source.id) continue;
      const id = edgeId(crawlSessionId, source.id, target.id);
      if (edges.has(id)) continue;
      const menu = link.menuPath.length > 0 || ['sidebar', 'header', 'navigation'].includes(link.region);
      edges.set(id, NavigationEdgeSchema.parse({
        id,
        session_id: crawlSessionId,
        source_node_id: source.id,
        target_node_id: target.id,
        label: link.label || null,
        interaction_type: menu ? 'menu' : 'link',
        observed_at: observation.completedAt,
      }));
    }
  }
  return [...edges.values()];
}
