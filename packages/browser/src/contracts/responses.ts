import { z } from 'zod';

/**
 * Response contracts of the NCrawl Browser API (v1).
 * - Objects are strict: a field added in code but not here fails contract validation (see NCRAWL_API_VALIDATE_RESPONSES).
 * - type-checks.ts proves at compile time that each schema's output type equals the TypeScript type the code returns.
 * - Optional fields use exactOptional (absent, never `undefined`), matching exactOptionalPropertyTypes.
 */

const opt = <T extends z.ZodType>(s: T) => s.exactOptional();
const iso = z.string().describe('ISO-8601 timestamp');
const Viewport = z.strictObject({ width: z.number(), height: z.number() });
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('[x, y, width, height] in document CSS pixels');

export const ProfileInfoSchema = z.strictObject({
  projectId: z.string(),
  displayName: z.string(),
  createdAt: iso,
  lastUsedAt: iso.nullable(),
  inUse: z.boolean(),
});

export const PageInfoSchema = z.strictObject({
  pageId: z.string(),
  status: z.enum(['open', 'crashed', 'closed']),
  url: z.string(),
  openerPageId: z.string().nullable(),
  createdAt: iso,
  crashedAt: iso.nullable(),
});

export const SessionInfoSchema = z.strictObject({
  sessionId: z.string(),
  kind: z.enum(['persistent', 'ephemeral']),
  projectId: z.string().nullable(),
  status: z.enum(['starting', 'running', 'closing', 'closed', 'disconnected']),
  headless: z.boolean(),
  viewport: Viewport,
  allowedOrigins: z.array(z.string()),
  createdAt: iso,
  endedAt: iso.nullable(),
  endReason: z.string().nullable(),
  restarts: z.number(),
  control: z.enum(['active', 'paused', 'stopping']),
  pages: z.array(PageInfoSchema),
});

export const NavigationResultSchema = z.strictObject({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  httpStatus: z.number().nullable(),
  title: z.string(),
  attempts: z.number(),
  durationMs: z.number(),
  redirected: z.boolean(),
  leftAllowedOrigins: z.boolean(),
  waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']),
});

export const OpenPageResultSchema = z.strictObject({ page: PageInfoSchema, navigation: NavigationResultSchema.nullable() });

const Initiator = z.enum(['ncrawl:navigate', 'ncrawl:back', 'ncrawl:forward', 'ncrawl:reload', 'ncrawl:recover', 'page']);
export const HistoryEntrySchema = z.strictObject({
  seq: z.number(),
  url: z.string(),
  fromUrl: z.string().nullable(),
  kind: z.enum(['document', 'same-document']),
  navigationType: z.string(),
  initiator: Initiator,
  timestamp: iso,
});

export const NetworkRecordSchema = z.strictObject({
  seq: z.number(),
  pageId: z.string().nullable(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  isNavigation: z.boolean(),
  state: z.enum(['pending', 'finished', 'failed', 'cancelled']),
  status: z.number().nullable(),
  contentType: z.string().nullable(),
  startedAt: iso,
  durationMs: z.number().nullable(),
  failure: z.string().nullable(),
});
export const NetworkQueryResultSchema = z.strictObject({ records: z.array(NetworkRecordSchema), droppedRecords: z.number() });

export const PageMetadataSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  lang: z.string().nullable(),
  viewport: Viewport,
  document: Viewport,
  scroll: z.strictObject({ x: z.number(), y: z.number() }),
  devicePixelRatio: z.number(),
  readyState: z.string(),
  text: z.strictObject({ wordCount: z.number(), headings: z.array(z.strictObject({ level: z.number(), text: z.string() })) }),
  innerScrollContainers: z.number(),
});

export const DomNodeSchema = z.strictObject({
  i: z.number(),
  parent: z.number(),
  tag: z.string(),
  attrs: opt(z.record(z.string(), z.string())),
  text: opt(z.string()),
  visible: z.boolean(),
  rect: opt(Rect),
  shadow: opt(z.boolean()),
});
export const DomSnapshotSchema = z.strictObject({
  nodes: z.array(DomNodeSchema),
  totalElements: z.number(),
  truncated: z.boolean(),
  frames: z.array(z.string()),
});

export const AxNodeSchema = z.strictObject({
  id: z.string(),
  parentId: z.string().nullable(),
  role: z.string(),
  name: z.string(),
  level: opt(z.number()),
  expanded: opt(z.boolean()),
  checked: opt(z.string()),
  selected: opt(z.boolean()),
  disabled: opt(z.boolean()),
  focusable: opt(z.boolean()),
  required: opt(z.boolean()),
  hasPopup: opt(z.string()),
  url: opt(z.string()),
  value: opt(z.string()),
});
export const AccessibilitySnapshotSchema = z.strictObject({
  nodes: z.array(AxNodeSchema),
  outline: z.string(),
  totalNodes: z.number(),
  truncated: z.boolean(),
});

const Region = z.enum(['breadcrumb', 'sidebar', 'header', 'footer', 'navigation', 'main', 'other']);
const Risk = z.enum(['safe', 'external', 'input', 'form-submit', 'mutating', 'logout', 'unknown-action']);
export const InteractiveElementSchema = z.strictObject({
  elementId: z.string(),
  role: z.string(),
  name: z.string(),
  label: z.string(),
  tag: z.string().nullable(),
  href: z.string().nullable(),
  sameOrigin: z.boolean().nullable(),
  region: Region,
  landmark: z.strictObject({ role: z.string(), name: z.string() }).nullable(),
  menuPath: z.array(z.string()),
  expanded: opt(z.boolean()),
  disabled: opt(z.boolean()),
  visible: z.boolean(),
  rect: Rect.nullable(),
  risk: Risk,
  riskReasons: z.array(z.string()),
  locator: z.strictObject({ role: z.string().nullable(), name: z.string(), exact: z.literal(true), nth: z.number(), testId: opt(z.string()) }),
});
export const NavigationLinkSchema = z.strictObject({
  elementId: z.string(),
  label: z.string(),
  url: z.string(),
  normalizedUrl: z.string(),
  sameOrigin: z.boolean(),
  region: Region,
  menuPath: z.array(z.string()),
  depth: z.number(),
  visible: z.boolean(),
  excluded: z.enum(['logout', 'external', 'self']).nullable(),
});
export const ExpandableGroupSchema = z.strictObject({
  elementId: z.string(),
  label: z.string(),
  expanded: z.boolean(),
  region: Region,
  menuPath: z.array(z.string()),
  risk: Risk,
});
export const InteractiveResultSchema = z.strictObject({
  elements: z.array(InteractiveElementSchema),
  navigationLinks: z.array(NavigationLinkSchema),
  expandableGroups: z.array(ExpandableGroupSchema),
  truncated: z.boolean(),
});

export const StabilityResultSchema = z.strictObject({
  stable: z.boolean(),
  waitedMs: z.number(),
  reason: z.enum(['stable', 'timeout-dom-busy', 'timeout-network-busy', 'page-closed']),
});

const CaptureMode = z.enum(['viewport', 'full_page']);
export const ScreenshotInfoSchema = z.strictObject({
  captureId: z.string(),
  seq: z.number(),
  file: z.string().describe('Path under the capture root; fetch with GET /v1/captures/{file}'),
  mode: CaptureMode,
  requestedMode: CaptureMode,
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  sha256: z.string(),
  url: z.string(),
  title: z.string(),
  viewport: Viewport,
  capturedAt: iso,
  historySeq: z.number(),
  status: z.enum(['ok', 'unstable', 'fallback']),
  notes: z.array(z.string()),
});

export const PageObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observationId: z.string(),
  sessionId: z.string(),
  projectId: z.string().nullable(),
  pageId: z.string(),
  startedAt: iso,
  completedAt: iso,
  status: z.enum(['complete', 'partial', 'failed']),
  errors: z.array(z.strictObject({
    part: z.enum(['metadata', 'dom', 'accessibility', 'interactive', 'screenshot', 'network', 'consistency']),
    code: z.string(),
    message: z.string(),
  })),
  stability: StabilityResultSchema.nullable(),
  metadata: PageMetadataSchema.nullable(),
  navigationSource: HistoryEntrySchema.pick({ seq: true, fromUrl: true, initiator: true, kind: true, navigationType: true, timestamp: true }).nullable(),
  dom: opt(DomSnapshotSchema),
  accessibility: opt(AccessibilitySnapshotSchema),
  interactiveElements: opt(z.array(InteractiveElementSchema)),
  navigationLinks: opt(z.array(NavigationLinkSchema)),
  expandableGroups: opt(z.array(ExpandableGroupSchema)),
  interactiveTruncated: opt(z.boolean()),
  screenshot: opt(ScreenshotInfoSchema),
  network: opt(z.strictObject({
    requests: z.array(NetworkRecordSchema),
    summary: z.strictObject({ total: z.number(), failed: z.number(), byType: z.record(z.string(), z.number()) }),
  })),
  file: opt(z.string()),
});

export const CaptureFileSchema = z.strictObject({ file: z.string(), kind: z.enum(['screenshot', 'screenshot-metadata', 'observation']), bytes: z.number() });

export const StatusSchema = z.strictObject({
  service: z.literal('ncrawl-browser'),
  apiVersion: z.string(),
  uptimeSeconds: z.number(),
  sessions: z.strictObject({ total: z.number(), running: z.number(), paused: z.number(), disconnected: z.number() }),
  profiles: z.number(),
  defaults: z.strictObject({ headless: z.boolean(), viewport: Viewport, navigationTimeoutMs: z.number() }),
});

export const HealthSchema = z.strictObject({ status: z.literal('ok') });
export const StopAllSchema = z.strictObject({ stopped: z.array(z.string()) });
export const DeletedSchema = z.strictObject({ deleted: z.string() });
export const ClosedSchema = z.strictObject({ closed: z.string() });

export const ErrorBodySchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
});
export const ErrorEnvelopeSchema = z.strictObject({ ok: z.literal(false), error: ErrorBodySchema });

/** Named schemas, as they appear under components/schemas in the OpenAPI document. */
export const NAMED_RESPONSE_SCHEMAS = {
  ProfileInfo: ProfileInfoSchema,
  PageInfo: PageInfoSchema,
  SessionInfo: SessionInfoSchema,
  NavigationResult: NavigationResultSchema,
  OpenPageResult: OpenPageResultSchema,
  HistoryEntry: HistoryEntrySchema,
  NetworkRecord: NetworkRecordSchema,
  NetworkQueryResult: NetworkQueryResultSchema,
  PageMetadata: PageMetadataSchema,
  DomNode: DomNodeSchema,
  DomSnapshot: DomSnapshotSchema,
  AxNode: AxNodeSchema,
  AccessibilitySnapshot: AccessibilitySnapshotSchema,
  InteractiveElement: InteractiveElementSchema,
  NavigationLink: NavigationLinkSchema,
  ExpandableGroup: ExpandableGroupSchema,
  InteractiveResult: InteractiveResultSchema,
  StabilityResult: StabilityResultSchema,
  ScreenshotInfo: ScreenshotInfoSchema,
  PageObservation: PageObservationSchema,
  CaptureFile: CaptureFileSchema,
  Status: StatusSchema,
  Health: HealthSchema,
  StopAll: StopAllSchema,
  Deleted: DeletedSchema,
  Closed: ClosedSchema,
  ErrorBody: ErrorBodySchema,
} as const;
