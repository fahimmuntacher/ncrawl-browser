#!/usr/bin/env node
/**
 * Writes the published contracts to docs/contracts/:
 *   openapi.json       — NCrawl Browser HTTP API (OpenAPI 3.1)
 *   sync.schema.json   — sync payloads for the FastAPI backend (JSON Schema 2020-12, snake_case)
 *   mcp-tools.json     — tools exposed to AI agents by the MCP adapter
 * `--check` compares instead of writing and exits 1 on drift (used by tests/CI).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { API_VERSION, buildRouter } from '../api/routes.ts';
import { TOOLS } from '../mcp/server.ts';
import { buildOpenApi } from './openapi.ts';
import { NAMED_SYNC_SCHEMAS } from './sync.ts';

export const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/contracts');

export function generateContracts(): Record<string, string> {
  const openapi = buildOpenApi(buildRouter({} as never), API_VERSION);

  const reg = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(NAMED_SYNC_SCHEMAS)) reg.add(schema, { id });
  const defs = z.toJSONSchema(reg, { uri: (id) => `#/$defs/${id}` }).schemas;
  const $defs = Object.fromEntries(Object.entries(defs).map(([id, s]) => {
    const { $schema: _a, $id: _b, ...rest } = s as Record<string, unknown>;
    return [id, rest];
  }));
  const sync = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ncrawl.local/contracts/sync.schema.json',
    title: 'NCrawl sync contracts',
    description: 'Records NCrawl sends to the FastAPI backend (PRD data model). Field names are snake_case. IDs are UUIDv5 derived from session + URL (nodes) or session + source + target (edges), so re-sync is an idempotent upsert.',
    $defs,
  };

  const mcp = {
    server: 'ncrawl-browser',
    transport: 'stdio',
    tools: Object.entries(TOOLS).map(([name, t]) => {
      const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
      return { name, description: t.description, inputSchema };
    }),
  };

  const fmt = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
  return { 'openapi.json': fmt(openapi), 'sync.schema.json': fmt(sync), 'mcp-tools.json': fmt(mcp) };
}

/** Files whose checked-in content differs from what the code generates. */
export async function checkContracts(): Promise<string[]> {
  const drift: string[] = [];
  for (const [name, content] of Object.entries(generateContracts())) {
    const current = await readFile(path.join(CONTRACTS_DIR, name), 'utf8').catch(() => null);
    if (current !== content) drift.push(name);
  }
  return drift;
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const drift = await checkContracts();
    if (drift.length) {
      console.error(`Contracts out of date: ${drift.join(', ')}. Run: npm run contracts -w @ncrawl/browser`);
      process.exit(1);
    }
    console.log('Contracts up to date.');
  } else {
    await mkdir(CONTRACTS_DIR, { recursive: true });
    for (const [name, content] of Object.entries(generateContracts())) {
      await writeFile(path.join(CONTRACTS_DIR, name), content);
      console.log(`wrote docs/contracts/${name} (${Buffer.byteLength(content)} bytes)`);
    }
  }
}
