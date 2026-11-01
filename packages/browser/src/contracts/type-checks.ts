/**
 * Compile-time drift detection: `npm run typecheck` fails if a response schema and the TypeScript type
 * the code actually returns ever disagree (a field added, removed, renamed, made optional or nullable).
 * This file has no runtime effect.
 */
import type { z } from 'zod';
import type { AccessibilitySnapshot } from '../inspection/accessibility.ts';
import type { DomSnapshot } from '../inspection/dom-snapshot.ts';
import type { PageObservation } from '../inspection/inspector.ts';
import type { InteractiveResult } from '../inspection/interactive.ts';
import type { PageMetadata } from '../inspection/page-metadata.ts';
import type { ScreenshotInfo } from '../inspection/screenshot.ts';
import type { StabilityResult } from '../inspection/stability.ts';
import type { HistoryEntry } from '../observers/history-recorder.ts';
import type { NetworkRecord } from '../observers/network-observer.ts';
import type { ProfileInfo } from '../profiles/profile-store.ts';
import type { NavigationResult } from '../runtime/navigation.ts';
import type { PageInfo } from '../runtime/page-registry.ts';
import type { SessionInfo } from '../runtime/session-manager.ts';
import type * as R from './responses.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Same<S extends z.ZodType, T> = Equals<z.output<S>, T>;

export type ContractChecks = [
  Same<typeof R.ProfileInfoSchema, ProfileInfo>,
  Same<typeof R.PageInfoSchema, PageInfo>,
  Same<typeof R.SessionInfoSchema, SessionInfo>,
  Same<typeof R.NavigationResultSchema, NavigationResult>,
  Same<typeof R.HistoryEntrySchema, HistoryEntry>,
  Same<typeof R.NetworkRecordSchema, NetworkRecord>,
  Same<typeof R.PageMetadataSchema, PageMetadata>,
  Same<typeof R.DomSnapshotSchema, DomSnapshot>,
  Same<typeof R.AccessibilitySnapshotSchema, AccessibilitySnapshot>,
  Same<typeof R.InteractiveResultSchema, InteractiveResult>,
  Same<typeof R.StabilityResultSchema, StabilityResult>,
  Same<typeof R.ScreenshotInfoSchema, ScreenshotInfo>,
  Same<typeof R.PageObservationSchema, PageObservation>,
];

// Every entry must be `true`; a mismatch turns one into `false` and this assignment fails to compile.
export const contractChecks: ContractChecks = [true, true, true, true, true, true, true, true, true, true, true, true, true];
