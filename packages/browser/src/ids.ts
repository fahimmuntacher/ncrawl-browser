import { randomUUID } from 'node:crypto';
import { NcrawlError } from './errors.ts';

/** Project IDs become directory names, so they are restricted to a safe slug. */
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function assertProjectId(id: string): string {
  if (!PROJECT_ID.test(id)) {
    throw new NcrawlError(
      'INVALID_INPUT',
      'projectId must be 1-64 chars of lowercase letters, digits and inner hyphens',
      { details: { projectId: id } },
    );
  }
  return id;
}

export function newId(prefix: 'ses' | 'pg'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
