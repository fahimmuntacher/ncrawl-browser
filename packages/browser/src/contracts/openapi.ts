import { z } from 'zod';
import type { Router } from '../api/http.ts';
import { ERROR_CODES } from '../errors.ts';
import * as Req from '../api/schemas.ts';
import { CreateSessionSchema, NavigateSchema } from '../schemas.ts';
import { ErrorEnvelopeSchema, NAMED_RESPONSE_SCHEMAS } from './responses.ts';

/** Request bodies shared by several routes get one stable name. */
const NAMED_REQUEST_SCHEMAS: Record<string, z.ZodType> = {
  EmptyRequest: Req.EmptyBody,
  CreateProfileRequest: Req.CreateProfileBody,
  CreateSessionRequest: CreateSessionSchema,
  OpenPageRequest: Req.OpenPageBody,
  NavigateRequest: NavigateSchema,
  HistoryNavRequest: Req.HistoryNavBody,
  ScreenshotRequest: Req.ScreenshotBody,
  StabilityRequest: Req.StabilityBody,
  InspectRequest: Req.InspectBody,
};

type Json = Record<string, unknown>;

/**
 * OpenAPI 3.1 document generated from the live route table and its zod schemas,
 * so the published contract cannot drift from what the server validates and returns.
 */
export function buildOpenApi(router: Router, version: string): Json {
  const responses = z.registry<{ id: string }>();
  const requests = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(NAMED_RESPONSE_SCHEMAS)) responses.add(schema, { id });
  responses.add(ErrorEnvelopeSchema, { id: 'ErrorEnvelope' });
  for (const [id, schema] of Object.entries(NAMED_REQUEST_SCHEMAS)) requests.add(schema, { id });

  const idFor = (reg: z.core.$ZodRegistry<{ id: string }>, schema: z.ZodType, fallback: string) => {
    const existing = reg.get(schema)?.id;
    if (existing) return existing;
    reg.add(schema, { id: fallback });
    return fallback;
  };

  const paths: Record<string, Json> = {};
  const pending: { op: string; path: string; method: string; build: () => Json }[] = [];

  for (const route of router.routes) {
    const oaPath = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const pathParams = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    const bodyId = route.body ? idFor(requests, route.body, `${pascal(route.op)}Request`) : null;
    const responseId = route.response ? idFor(responses, route.response, `${pascal(route.op)}Response`) : null;
    const querySchema = route.query;

    pending.push({
      op: route.op, path: oaPath, method: route.method.toLowerCase(),
      build: () => {
        const parameters: Json[] = [...pathParams];
        if (querySchema) {
          const js = z.toJSONSchema(querySchema, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, Json>; required?: string[] };
          for (const [name, schema] of Object.entries(js.properties ?? {})) {
            parameters.push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema });
          }
        }
        const ok: Json = route.raw
          ? { description: 'File contents', content: Object.fromEntries(route.raw.map((t) => [t, { schema: t === 'image/png' ? { type: 'string', format: 'binary' } : {} }])) }
          : {
              description: 'Success',
              content: { 'application/json': { schema: {
                type: 'object', required: ['ok', 'data'], additionalProperties: false,
                properties: { ok: { const: true }, data: responseId ? { $ref: `#/components/schemas/${responseId}` } : {} },
              } } },
            };
        return {
          operationId: route.op,
          summary: route.summary,
          tags: [tagFor(route.path)],
          ...(route.op === 'health' || route.op === 'get_openapi' ? { security: [] } : {}),
          ...(parameters.length ? { parameters } : {}),
          ...(bodyId ? { requestBody: { required: false, content: { 'application/json': { schema: { $ref: `#/components/schemas/${bodyId}` } } } } } : {}),
          responses: {
            [String(route.status ?? 200)]: ok,
            default: { description: 'Error (see error.code)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
          },
        };
      },
    });
  }
  for (const p of pending) (paths[p.path] ??= {})[p.method] = p.build();

  const uri = (id: string) => `#/components/schemas/${id}`;
  const out = z.toJSONSchema(responses, { io: 'output', uri, unrepresentable: 'any' }).schemas;
  const inp = z.toJSONSchema(requests, { io: 'input', uri, unrepresentable: 'any' }).schemas;
  const schemas: Record<string, Json> = {};
  for (const [id, s] of Object.entries({ ...out, ...inp })) {
    const { $schema: _a, $id: _b, ...rest } = s as Json;
    schemas[id] = rest;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'NCrawl Browser API',
      version,
      description:
        'Local, loopback-only API that controls NCrawl Browser sessions (Playwright/Chromium) for authorized inspection. ' +
        'All responses use the envelope { ok: true, data } or { ok: false, error }. ' +
        `Error codes: ${ERROR_CODES.join(', ')}.`,
    },
    servers: [{ url: 'http://127.0.0.1:4700', description: 'Default local service (NCRAWL_API_PORT)' }],
    security: [{ bearerAuth: [] }],
    tags: ['service', 'profiles', 'sessions', 'pages', 'inspection', 'captures'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Token from <NCRAWL_DATA_DIR>/api-token or NCRAWL_API_TOKEN' },
      },
      schemas,
    },
  };
}

function pascal(op: string): string {
  return op.split(/[_-]/).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
}

function tagFor(path: string): string {
  if (path.startsWith('/v1/profiles')) return 'profiles';
  if (path.startsWith('/v1/captures')) return 'captures';
  if (/\/(metadata|dom|accessibility|interactive-elements|wait-for-stable|screenshot|inspect)$/.test(path)) return 'inspection';
  if (path.includes('/pages')) return 'pages';
  if (path.startsWith('/v1/sessions')) return 'sessions';
  return 'service';
}
