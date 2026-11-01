import { z } from 'zod';

/** Request schemas shared by the runtime and (Phase 3) the HTTP API. */

export const ProjectIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'lowercase slug, 1-64 chars');

export const ViewportSchema = z.object({
  width: z.number().int().min(320).max(7_680),
  height: z.number().int().min(240).max(4_320),
});

export const CreateSessionSchema = z
  .object({
    /** persistent = the project's saved profile (logins survive restarts); ephemeral = fresh, discarded on close. */
    kind: z.enum(['persistent', 'ephemeral']).default('persistent'),
    projectId: ProjectIdSchema.optional(),
    headless: z.boolean().optional(),
    viewport: ViewportSchema.optional(),
    /** Exact origins this session may be told to open. Empty = any http(s) URL. */
    allowedOrigins: z.array(z.url()).max(50).default([]),
  })
  .strict()
  .refine((v) => v.kind === 'ephemeral' || v.projectId !== undefined, {
    message: 'projectId is required for persistent sessions',
    path: ['projectId'],
  });

export type CreateSessionInput = z.input<typeof CreateSessionSchema>;
export type CreateSessionOptions = z.output<typeof CreateSessionSchema>;

export const NavigateSchema = z
  .object({
    url: z.string().min(1).max(8_192),
    waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    retries: z.number().int().min(0).max(5).optional(),
  })
  .strict();
