// A parent turns "Allow child customization" OFF. Whether that "off" holds has
// to survive the database having a bad minute.
//
// `family_dashboard_settings` holds one row per family, and its columns DEFAULT
// to allow=true / lock=false (0094:12-13), so a family with NO row is
// legitimately permissive. PostgREST resolves a failed read with
// `{ data: null, error }` — the SAME `data: null` as "no row". Both readers of
// this table dropped the error, so a statement timeout was indistinguishable
// from "this family never touched the setting" and collapsed to the PERMISSIVE
// default: the child was shown the Customize control and their save was
// accepted.
//
// The residue is what makes it worth a test. The accepted save writes a
// `scope='user'` row to dashboard_layouts, and nothing ever re-examines it —
// `effectiveSavedKeys` prefers a personal layout over the family default on
// every later render, so the parent's "off" stays quietly untrue long after the
// database recovers, and the only cure wipes EVERY member's layout
// (resetAllLayoutsAction).
//
// RLS is deliberately not the boundary here: 0325:81-87 classifies these two
// flags as a live product setting and lets any member write their own
// `scope='user'` row (0325:146-151), precisely so a teen can arrange their own
// home screen. The TypeScript check is therefore the only place this rule
// lives, which is exactly why it may not fail open.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readDashSettings, canCustomizeDashboard, effectiveSavedKeys,
} from '@/lib/dashboard/permissions';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: mocks.requireUserContext,
  effectivePlanLevel: async (level: string) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 'plus' }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The REAL en-US catalogue on both sides, so a missing sentence renders as its
// key and fails an assertion instead of passing as one.
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: en, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(en, key, params) };
});
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES: en, translate: tr } = await import('@/lib/i18n/messages');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => tr(en, key, params) };
});
// quick-actions is a client component; these are the three hooks it needs a
// provider for. Nothing here is clicked, so they only have to exist.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));

const { saveDashboardLayoutAction } = await import('@/app/(app)/dashboard/customize-actions');
const { DashboardQuickActions } = await import('@/components/dashboard/quick-actions');

const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
const CHILD = { user: { id: 'child-1' }, active: { familyId: 'fam-1', role: 'child' } };

// What the parent actually saved: children may NOT customize, and the family is
// NOT locked — the one configuration where a personal row would win on screen.
const CHILD_CUSTOMIZATION_OFF = { allow_child_customization: false, lock_to_family_default: false };

type Read = { data: unknown; error: unknown };
let settingsRead: Read;
let layoutWrites: Record<string, unknown>[];

// Chainable PostgREST stub. Reads answer from `settingsRead`; any write to
// dashboard_layouts is recorded rather than performed.
function from(table: string) {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => (table === 'family_dashboard_settings' ? settingsRead : { data: null, error: null }),
    insert: async () => ({ data: null, error: null }),
    upsert: async (row: Record<string, unknown>) => {
      if (table === 'dashboard_layouts') layoutWrites.push(row);
      return { data: null, error: null };
    },
  });
  return query;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  settingsRead = { data: CHILD_CUSTOMIZATION_OFF, error: null };
  layoutWrites = [];
  mocks.requireUserContext.mockResolvedValue(CHILD);
  mocks.createServer.mockResolvedValue({ from });
});

describe("a child's save while the family's settings cannot be read", () => {
  it('does not persist a layout the parent had switched off', async () => {
    settingsRead = { data: null, error: TIMEOUT };

    const result = await saveDashboardLayoutAction({ featureKeys: ['meals', 'chores'] });

    // The whole point. This row is the permanent residue: once written, it wins
    // over the family default on every later render, database recovered or not.
    expect(layoutWrites, 'a settings read that failed must not be followed by a layout write').toEqual([]);
    expect(result.ok, 'a save the rules could not authorize is not ok').toBe(false);
  });

  it('tells the child it is a transient failure, not a new family policy', async () => {
    settingsRead = { data: null, error: TIMEOUT };

    const result = await saveDashboardLayoutAction({ featureKeys: ['meals'] });

    // Not "a parent has turned off dashboard customization" — we never read it.
    // The English sentence, not the key: a missing catalogue entry renders the
    // bare key at the child, and that must fail here. RED until the orchestrator
    // merges customizeActions.settingsUnreadable (scratchpad/i18n-asks/m15.json)
    // into the catalogues, which lands in the same commit as this test.
    expect(result.error).toBe('We couldn’t check your family’s dashboard settings just now. Please try again in a moment.');
    expect(result.error).not.toMatch(/parent/i);
  });

  it('still refuses the child on a healthy read of the same "off" setting', async () => {
    const result = await saveDashboardLayoutAction({ featureKeys: ['meals'] });

    expect(layoutWrites).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/turned off dashboard customization/);
  });

  it('still lets a child customize in a family that never set the toggle', async () => {
    settingsRead = { data: null, error: null };

    const result = await saveDashboardLayoutAction({ featureKeys: ['meals', 'chores'] });

    // The permissive default is correct for an ABSENT row, and stays correct.
    expect(result).toEqual({ ok: true });
    expect(layoutWrites).toHaveLength(1);
    expect(layoutWrites[0]).toMatchObject({ scope: 'user', user_id: 'child-1', feature_keys: ['meals', 'chores'] });
  });
});

describe('what /dashboard renders while the settings cannot be read', () => {
  const CHILD_IS_MANAGER = false;
  const MY_KEYS = ['mine-1', 'mine-2'];
  const FAMILY_KEYS = ['family-1', 'family-2'];

  it('does not offer the Customize control to a child', () => {
    const { settings } = readDashSettings(null, TIMEOUT);

    // canCustomizeDashboard is what gates the button (quick-actions.tsx:101).
    expect(canCustomizeDashboard(CHILD_IS_MANAGER, settings)).toBe(false);
  });

  it('keeps members on the layout an unlocked family sees, not the family one', () => {
    const { settings } = readDashSettings(null, TIMEOUT);
    const neverSetAnything = readDashSettings(null, null).settings;

    // The lock only picks which saved layout is SHOWN; it grants nothing
    // (0325:81-87). Assuming it ON would move every member of a family that
    // never locked anything — the default — onto the family layout for as long
    // as the read keeps failing.
    expect(effectiveSavedKeys(MY_KEYS, FAMILY_KEYS, settings)).toEqual(MY_KEYS);
    expect(effectiveSavedKeys(MY_KEYS, FAMILY_KEYS, settings)).toEqual(effectiveSavedKeys(MY_KEYS, FAMILY_KEYS, neverSetAnything));
  });

  it("opens a parent's editor on their own layout, so a later Save cannot overwrite it with the family's", () => {
    const { settings } = readDashSettings(null, TIMEOUT);

    // A parent keeps Customize; the action refuses the save while the read is
    // still failing, with the retryable message above.
    expect(canCustomizeDashboard(true, settings)).toBe(true);
    // ai-home-dashboard seeds the editor with effectiveSavedKeys(...). Seeded
    // with FAMILY_KEYS, a Save made once the database recovers would upsert the
    // family's tiles as this parent's personal row, replacing their own.
    expect(effectiveSavedKeys(MY_KEYS, FAMILY_KEYS, settings)).not.toEqual(FAMILY_KEYS);
  });

  it("does not hand a parent's settings form values it never read", () => {
    // FamilySettingsModal PREFILLS the two toggles from this object, so passing
    // an assumed shape would let one Save persist a policy nobody chose.
    expect(readDashSettings(null, TIMEOUT).unknown).toBe(true);
  });

  it('leaves a healthy read alone — off stays off, absent stays permissive', () => {
    const off = readDashSettings(CHILD_CUSTOMIZATION_OFF, null);
    expect(off.unknown).toBe(false);
    expect(canCustomizeDashboard(CHILD_IS_MANAGER, off.settings)).toBe(false);
    expect(effectiveSavedKeys(MY_KEYS, FAMILY_KEYS, off.settings)).toEqual(MY_KEYS);

    const absent = readDashSettings(null, null);
    expect(absent.unknown).toBe(false);
    expect(canCustomizeDashboard(CHILD_IS_MANAGER, absent.settings)).toBe(true);
  });
});

describe('the Quick Access header while the settings cannot be read', () => {
  const OFF = readDashSettings(CHILD_CUSTOMIZATION_OFF, null).settings;
  const UNKNOWN = readDashSettings(null, TIMEOUT).settings;
  const render = (props: Partial<React.ComponentProps<typeof DashboardQuickActions>>) => renderToStaticMarkup(
    React.createElement(DashboardQuickActions, { fixed: [], primaryKeys: [], available: [], locked: [], ...props }),
  );
  // Each header control is an icon followed by its en-US label.
  const control = (label: string) => new RegExp(`</svg> ${label}</(button|span)>`);

  it('does not tell a child that a parent locked it', () => {
    // What ai-home-dashboard hands a child when the read failed: no Customize,
    // settings withheld.
    const html = render({ canCustomize: canCustomizeDashboard(false, UNKNOWN), settings: undefined });

    expect(html).not.toMatch(control('Customize'));
    // "Set by a parent" asserts a policy nobody read — the same claim the
    // action's error was worded to avoid.
    expect(html).not.toMatch(control('Set by a parent'));
    // Positive control: the same child on a healthy read of "off" IS told.
    expect(render({ canCustomize: canCustomizeDashboard(false, OFF), settings: OFF })).toMatch(control('Set by a parent'));
  });

  it('gives a parent no Family button to open on values nobody read', () => {
    // The modal it opens needs `settings` to prefill; without them the button
    // would do nothing, so it is not drawn even if a caller passes canManage.
    expect(render({ canManage: true, settings: undefined })).not.toMatch(control('Family'));
    expect(render({ canManage: true, settings: OFF })).toMatch(control('Family'));
  });
});
