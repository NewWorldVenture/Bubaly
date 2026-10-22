// The shared state a module-harness test drives a client component against.
//
// React-free on purpose: a test creates it inside `vi.hoisted`, before any mock
// exists, and the mock factories in tests/helpers/module-harness.tsx read and
// write it. See that file for how the pieces fit.
import { createHookSlots, type HookSlots } from './hook-slots';

export type HarnessRow = Record<string, unknown>;
export type HarnessFault = { message: string; code?: string };

export type ModuleState = {
  hooks: HookSlots;
  /** The database: an InMemorySupabase, set by the test before each case. */
  db: unknown;
  /** Storage buckets: bucket → object paths. Refused paths survive a remove. */
  storage: { objects: Map<string, Set<string>>; refused: Set<string> };
  /** What each `useRealtimeQuery` list holds — the screen, not the database. */
  rows: Record<string, HarnessRow[]>;
  /** A table whose list read failed, as the hook exposes it. */
  readErrors: Record<string, string>;
  /** Tables a component asked to re-read, in order. */
  refreshes: string[];
  /**
   * What the real hook's realtime (or 'online') callback does for a table:
   * re-read with the component's latest fetcher, without the component
   * asking. Filled by `fetchedQueryModule`; a test calls it where an event
   * would arrive.
   */
  realtime: Record<string, () => Promise<unknown>>;
  app: {
    familyId: string; userId: string;
    members: HarnessRow[]; selfMember: HarnessRow | null; family: HarnessRow;
  };
  /** The family's zone, as `useFamilyTimeZone()` reports it. */
  timeZone: string | undefined;
  toasts: { success: string[]; error: string[] };
  /** What `useConfirm()` answers. */
  confirmAnswer: boolean;
  /**
   * A fault for one database call: given the table and the builder methods
   * called on it (`['update', 'eq', 'select']`), answer an error, or null to
   * let the in-memory database reply.
   */
  fault: ((table: string, calls: string[]) => HarnessFault | null) | null;
  /** Every database call the component made: table and builder methods. */
  calls: { table: string; calls: string[] }[];
};

export function createModuleState(): ModuleState {
  return {
    hooks: createHookSlots(),
    db: null,
    storage: { objects: new Map(), refused: new Set() },
    rows: {},
    readErrors: {},
    refreshes: [],
    realtime: {},
    app: {
      familyId: '0f0f0f0f-0000-4000-8000-000000000001', userId: 'user-1',
      members: [{ id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null }],
      selfMember: { id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
      family: { id: '0f0f0f0f-0000-4000-8000-000000000001', name: 'Fixture family', timezone: 'UTC' },
    },
    timeZone: 'UTC',
    toasts: { success: [], error: [] },
    confirmAnswer: true,
    fault: null,
    calls: [],
  };
}
