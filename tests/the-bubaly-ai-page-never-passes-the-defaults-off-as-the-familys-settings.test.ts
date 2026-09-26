// Settings → Bubaly AI, when the read of `family_ai_settings` FAILS.
//
// The service has a forgiving read that answers the defaults on a failure (the
// gate uses it so a settings hiccup never stops a family's work). The page used
// that same read, so during any failed read — a PostgREST 5xx, a statement
// timeout, a dropped connection — `loadAISettingsAction` answered `ok: true`
// with invented values: Bubaly ON, `execute` everywhere, memory ON, no quiet
// hours. A family that had switched Bubaly off was told it was on, with no
// sign anything was wrong. And because two of the panel's controls edit FROM
// what the page shows, a parent who then touched one category wrote the
// invented empty map over every level they had set, and one who touched a
// quiet-hours dropdown had the other end of their night rewritten to 7am/9pm.
//
// These tests run the real action over the real service against an in-memory
// row, so what they assert is what the family's page and the family's row
// actually end up as.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@/lib/ai/family-settings';

type Row = Record<string, unknown> & { family_id: string };

const state = vi.hoisted(() => ({
  row: null as Row | null,
  /** When set, the next reads of `family_ai_settings` fail with this error. */
  readError: null as { message: string; code?: string } | null,
}));

function fakeDb() {
  return {
    from(table: string) {
      if (table !== 'family_ai_settings') throw new Error(`unexpected table ${table}`);
      let op: 'select' | 'upsert' = 'select';
      let payload: Row | null = null;
      const b = {
        select: () => b,
        eq: () => b,
        upsert: (p: Row) => { op = 'upsert'; payload = p; return b; },
        maybeSingle: async () => {
          if (state.readError) return { data: null, error: state.readError };
          return { data: state.row ? { ...state.row } : null, error: null };
        },
        single: async () => {
          if (op !== 'upsert' || !payload) throw new Error('only an upsert ends in single()');
          // A transient read failure does not mean the write fails too: the
          // upsert goes through, which is what made the write-back real.
          state.row = { ...(state.row ?? {}), ...payload };
          return { data: { ...state.row }, error: null };
        },
      };
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeDb() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'auth-1', email: 'parent@example.com' },
    memberships: [],
    active: {
      familyId: 'fam-1',
      family: { id: 'fam-1', name: 'The Riveras', timezone: 'America/New_York' },
      role: 'parent',
      member: { id: 'member-1', family_id: 'fam-1', user_id: 'auth-1' },
    },
  }),
}));

const { loadAISettingsAction, saveAISettingsAction } = await import('@/app/(app)/dashboard/settings/ai-actions');

/** A family that has tightened almost everything Bubaly may do. */
const THE_RIVERAS: Row = {
  family_id: 'fam-1',
  enabled: false,
  behavior: 'prepare',
  category_behavior: { finances: 'recommend', meals: 'execute' },
  risk_overrides: {},
  child_channels: {},
  memory_enabled: false,
  quiet_hours_start: 21,
  quiet_hours_end: 6,
  updated_by: 'auth-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const TIMEOUT = { message: 'canceling statement due to statement timeout', code: '57014' };

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.row = { ...THE_RIVERAS };
  state.readError = null;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('the Bubaly AI page when the settings read fails', () => {
  it('says it could not load them — it does not tell a family that switched Bubaly off that Bubaly is on', async () => {
    state.readError = TIMEOUT;
    const page = await loadAISettingsAction();

    expect(page).toEqual({ ok: false, error: 'Could not load your Bubaly settings.' });
    // Nothing internal reaches the page…
    expect(JSON.stringify(page)).not.toContain('statement timeout');
    // …but an operator can still see what happened.
    expect(consoleError).toHaveBeenCalledWith('[service:ai-settings] read failed', TIMEOUT);
  });

  it('shows the family’s own settings once the read works again', async () => {
    state.readError = TIMEOUT;
    await loadAISettingsAction();
    state.readError = null;

    const page = await loadAISettingsAction();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.settings).toMatchObject({
      enabled: false,
      behavior: 'prepare',
      categoryBehavior: { finances: 'recommend', meals: 'execute' },
      memoryEnabled: false,
      quietHours: { start: 21, end: 6 },
    });
  });

  it('still shows the defaults to a family with no row yet — that is what the gate enforces for them', async () => {
    // Absence is not failure: 0257 backfills a row, but where one is missing
    // the gate reads the defaults, so the page saying so is the truth.
    state.row = null;
    const page = await loadAISettingsAction();
    expect(page).toEqual({ ok: true, settings: { familyId: 'fam-1', ...DEFAULT_AI_SETTINGS } });
  });
});

describe('a parent editing during a failed read cannot overwrite what they never saw', () => {
  // The panel only puts controls on the screen for an `ok` answer, and each
  // control builds its patch from the settings on the screen. These replay
  // exactly what components/settings/ai-settings.tsx sends.

  it('changing one category leaves every other category the family set', async () => {
    state.readError = TIMEOUT;
    const page = await loadAISettingsAction();
    if (page.ok) {
      // The category picker: `{ ...settings.categoryBehavior, [domain]: behavior }`.
      await saveAISettingsAction({ categoryBehavior: { ...page.settings.categoryBehavior, meals: 'prepare' } });
    }
    // Finances is still on Recommend: Bubaly still may not act there unasked.
    expect(state.row?.category_behavior).toEqual({ finances: 'recommend', meals: 'execute' });
  });

  it('changing one end of quiet hours does not rewrite the other end', async () => {
    state.readError = TIMEOUT;
    const page = await loadAISettingsAction();
    if (page.ok) {
      // The "From" select: the end it did not see is filled with `?? 7`.
      const end = page.settings.quietHours?.end ?? 7;
      await saveAISettingsAction({ quietHours: { start: 22, end } });
    }
    expect(state.row).toMatchObject({ quiet_hours_start: 21, quiet_hours_end: 6 });
  });
});
