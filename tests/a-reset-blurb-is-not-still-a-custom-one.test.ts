// The super-admin Service Catalog editor used to report the opposite of what it
// had just done.
//
// /admin/services (app/(app)/admin/services/page.tsx) renders
// ServiceDescriptionsEditor with the stored overrides. "Reset" on a customized
// row is meant to drop the override so the service falls back to the shipped
// copy in lib/services/descriptions.ts. The server half always did exactly that:
// saveServiceDescriptionAction DELETEs the service_descriptions row for an empty
// (or same-as-default) value, and every family's "All Services" tooltip
// correctly reverted.
//
// The editor then told the admin the reset had not happened. `resetToDefault`
// optimistically showed the default, but `persist` settled BOTH state maps to
// the string it had SENT the server — '' — and every shipped default is
// non-empty, so `isOverride` (`saved[key] !== SERVICE_DESCRIPTIONS[key]`) stayed
// true: blank textarea, CUSTOM badge still on the row, header still reading
// "N customized", and Save disabled because '' is not dirty against ''. The row
// was stuck — clicking Reset again reproduced it, and only a full page reload
// showed the truth. The same clobber was reachable by clearing the box by hand
// and pressing Save.
//
// These tests drive the REAL component through the hook-slot harness this suite
// uses for client components (there is no DOM here) against the REAL server
// action over a fake `service_descriptions` table, and assert what the admin
// reads on the screen: the blurb in the box, the badge, and the header count.
//
// The props are re-derived from the fake table on every render, so the editor is
// handed CORRECT overrides after the write — which is what `revalidatePath`
// gives it. React keeps the mounted `useState` maps regardless (the harness
// mirrors that: a `useState` initializer is ignored after the first call), which
// is precisely why the stale badge survived the revalidate.
//
// JSX-free and `.ts` on purpose: vitest.config.ts includes only
// tests/**/*.test.ts.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { SERVICE_DESCRIPTIONS } from '@/lib/services/descriptions';
import { translate } from '@/lib/i18n/translate';

// The editor AND the server action translate through the REAL en-US catalogue,
// with production's behaviour for a missing key: the key itself is what renders.
const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) => translate(EN_US, key, params);

const CAL = '/dashboard/calendar';
const INBOX = '/dashboard/inbox';

// Every assertion below is the English the super admin reads, typed out here —
// never looked up — so a key missing from the catalogue fails it instead of
// matching the key it fell back to. RESET_TOAST is new with this fix and reaches
// en-US.json through the catalogue merge that lands in the same commit; UNTIL
// THAT MERGE LANDS the successful-reset cases are red, which is the point:
// without it the toast reads `serviceDescriptionsEditor.descriptionReset`.
const CUSTOM_BADGE = 'Custom';
const RESET_LABEL = 'Reset';
const SAVED_TOAST = 'Description saved.';
const RESET_TOAST = 'Description reset to the default.';
const NOT_AUTHORIZED = 'Not authorized.';
// The header line and the Save button's two labels are hardcoded English in the
// component, not catalogue copy. Because the translator above is the real one,
// an i18n pass that moves them into the catalogue with the same English leaves
// these cases green; only a change of the words themselves touches them.
const SAVE_LABEL = 'Save';
const SAVED_LABEL = 'Saved';
const ONE_CUSTOMIZED = '1 customized';
const TWO_CUSTOMIZED = '2 customized';
const NONE_CUSTOMIZED = 'All using defaults';

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  // The one table this screen writes. `service_key -> description`.
  db: {} as Record<string, string>,
  writeFails: false,
  superAdmin: true,
  success: vi.fn(),
  error: vi.fn(),
}));

// The hook-slot harness: `useState` keeps its value across renders the way a
// mounted component does, and an initializer handed to an already-initialized
// slot is ignored — the same reason fresh server props do not reset this screen.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [state.slots[index], (value: unknown) => {
      state.slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(state.slots[index]) : value;
    }];
  },
  useMemo: (fn: () => unknown) => fn(),
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => t }));

// Server-action dependencies. Everything else in the action — the super-admin
// gate, the known-key whitelist, the empty/same-as-default delete rule and the
// trim/cap — is the real code under test.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => t }));
vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => state.superAdmin,
  getUser: async () => ({ id: 'admin-1' }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'service_descriptions') throw new Error(`unexpected table ${table}`);
      const rejected = { error: { message: 'permission denied for table service_descriptions', code: '42501' } };
      return {
        delete: () => ({
          eq: async (column: string, key: string) => {
            if (column !== 'service_key') throw new Error(`unexpected column ${column}`);
            if (state.writeFails) return rejected;
            delete state.db[key];
            return { error: null };
          },
        }),
        upsert: async (row: { service_key: string; description: string }) => {
          if (state.writeFails) return rejected;
          state.db[row.service_key] = row.description;
          return { error: null };
        },
      };
    },
  }),
}));

const { ServiceDescriptionsEditor } = await import('@/components/admin/service-descriptions-editor');

type Node = ReactElement<Record<string, unknown>>;

function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

const groups = [{ title: 'Daily', items: [{ key: CAL, label: 'Calendar' }, { key: INBOX, label: 'Inbox' }] }];

/** What the page would hand the editor right now — mirrors loadServiceDescriptionOverrides. */
function serverProps(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, description] of Object.entries(state.db)) if (description.trim()) out[key] = description.trim();
  return out;
}

/** The screen the super admin is looking at. */
function render(): ReactNode {
  state.cursor = 0;
  return ServiceDescriptionsEditor({ groups, overrides: serverProps() });
}

function row(tree: ReactNode, key: string): Node {
  const found = nodes(tree).find((node) => node.type === 'div' && node.key === key);
  if (!found) throw new Error(`No row rendered for ${key}`);
  return found;
}
/** The copy in the row's textarea — the blurb the admin reads. */
function blurb(tree: ReactNode, key: string): string {
  const area = nodes(row(tree, key)).find((node) => node.type === 'textarea');
  if (!area) throw new Error(`No textarea in the ${key} row`);
  return String(area.props.value ?? '');
}
/** Whether the row still wears the CUSTOM badge. */
function badged(tree: ReactNode, key: string): boolean {
  return nodes(row(tree, key)).some((node) => node.type === 'span' && text(node).trim() === CUSTOM_BADGE);
}
/** The "N customized · M services" line above the list. */
function header(tree: ReactNode): string {
  const line = nodes(tree).find((node) => node.type === 'p' && node.props.className === 'text-xs text-muted');
  if (!line) throw new Error('No header count line');
  return text(line);
}
function buttons(tree: ReactNode, key: string): Node[] {
  return nodes(row(tree, key)).filter((node) => node.type === 'button');
}
/** The row's buttons are found by the label the admin reads, never by position. */
function labelled(tree: ReactNode, key: string, labels: string[]): Node | undefined {
  const found = buttons(tree, key).filter((node) => labels.includes(text(node).trim()));
  if (found.length > 1) throw new Error(`${found.length} buttons labelled ${labels.join('/')} on the ${key} row`);
  return found[0];
}
function resetButton(tree: ReactNode, key: string): Node {
  const found = labelled(tree, key, [RESET_LABEL]);
  if (!found) throw new Error(`No Reset button on the ${key} row`);
  return found;
}
function saveButton(tree: ReactNode, key: string): Node {
  const found = labelled(tree, key, [SAVE_LABEL, SAVED_LABEL]);
  if (!found) throw new Error(`No Save button on the ${key} row`);
  return found;
}
/** What the Save button reads right now: 'Save', or 'Saved' while its tick shows. */
const saveLabel = (tree: ReactNode, key: string) => text(saveButton(tree, key)).trim();
function typeInto(tree: ReactNode, key: string, value: string) {
  const area = nodes(row(tree, key)).find((node) => node.type === 'textarea');
  (area!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}
const click = (node: Node) => (node.props.onClick as () => Promise<void> | void)();
/**
 * Flush the round trip a handler kicked off. setImmediate, not setTimeout:
 * setTimeout is faked (below), and the round trip is only promises anyway.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  // The Save button's 1.5 s "Saved" tick is a setTimeout. Faked so a case can
  // step past it, and so a tick left by one case cannot fire into the next one's
  // slots (the harness's setters write through the shared `state`).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  state.slots = []; state.cursor = 0;
  state.db = { [CAL]: 'Our own calendar blurb.' };
  state.writeFails = false; state.superAdmin = true;
  state.success.mockReset(); state.error.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a reset blurb is not still a custom one', () => {
  it('reset puts the shipped default in the box and takes the CUSTOM badge off the row', async () => {
    const before = render();
    expect(blurb(before, CAL)).toBe('Our own calendar blurb.');
    expect(badged(before, CAL)).toBe(true);
    expect(header(before)).toContain(ONE_CUSTOMIZED);

    await click(resetButton(before, CAL));
    await settle();

    // The server did its half: the override row is gone, so every family's
    // tooltip is back on the shipped copy.
    expect(state.db[CAL]).toBeUndefined();

    // And the screen says so, on all three counts the admin reads.
    const after = render();
    expect(blurb(after, CAL)).toBe(SERVICE_DESCRIPTIONS[CAL]);
    expect(blurb(after, CAL)).not.toBe('');
    expect(badged(after, CAL)).toBe(false);
    expect(header(after)).toContain(NONE_CUSTOMIZED);
    expect(header(after)).not.toContain('customized');

    // The row is not stuck: there is nothing left to save, and nothing left to reset.
    expect(saveButton(after, CAL).props.disabled).toBe(true);
    expect(labelled(after, CAL, [RESET_LABEL])).toBeUndefined();
    // Reported as the reset it was — in the toast, in English, and without the
    // Save button claiming a save that never happened.
    expect(state.success).toHaveBeenCalledWith(RESET_TOAST);
    expect(saveLabel(after, CAL)).toBe(SAVE_LABEL);
    expect(state.error).not.toHaveBeenCalled();
  });

  it('a reset right after a save does not keep the save\'s "Saved" tick on the button', async () => {
    const before = render();
    typeInto(before, CAL, 'A newer calendar blurb.');
    await click(saveButton(render(), CAL));
    await settle();

    // The save's own feedback, as a control: the tick shows, then goes after 1.5 s.
    const saved = render();
    expect(saveLabel(saved, CAL)).toBe(SAVED_LABEL);
    expect(state.success).toHaveBeenLastCalledWith(SAVED_TOAST);

    // Reset inside that 1.5 s window.
    await click(resetButton(saved, CAL));
    await settle();

    const after = render();
    expect(state.db[CAL]).toBeUndefined();
    expect(state.success).toHaveBeenLastCalledWith(RESET_TOAST);
    expect(saveLabel(after, CAL)).toBe(SAVE_LABEL);
    vi.advanceTimersByTime(1500);
    expect(saveLabel(render(), CAL)).toBe(SAVE_LABEL);
  });

  it('clearing the box by hand and pressing Save lands on the default too, not on a blank CUSTOM row', async () => {
    const before = render();
    typeInto(before, CAL, '');

    const emptied = render();
    expect(blurb(emptied, CAL)).toBe('');
    expect(saveButton(emptied, CAL).props.disabled).toBe(false);

    await click(saveButton(emptied, CAL));
    await settle();

    expect(state.db[CAL]).toBeUndefined();
    const after = render();
    expect(blurb(after, CAL)).toBe(SERVICE_DESCRIPTIONS[CAL]);
    expect(badged(after, CAL)).toBe(false);
    expect(header(after)).toContain(NONE_CUSTOMIZED);
    expect(state.success).toHaveBeenCalledWith(SAVED_TOAST);
  });

  it('a real override still reads as CUSTOM after it is saved', async () => {
    const before = render();
    typeInto(before, INBOX, '  Our inbox rules.  ');

    await click(saveButton(render(), INBOX));
    await settle();

    // Stored trimmed, and the box shows what was stored — not the raw typing.
    expect(state.db[INBOX]).toBe('Our inbox rules.');
    const after = render();
    expect(blurb(after, INBOX)).toBe('Our inbox rules.');
    expect(badged(after, INBOX)).toBe(true);
    expect(badged(after, CAL)).toBe(true);
    expect(header(after)).toContain(TWO_CUSTOMIZED);
    expect(saveButton(after, INBOX).props.disabled).toBe(true);
    expect(state.success).toHaveBeenCalledWith(SAVED_TOAST);
    // A save does flash its tick, for 1.5 s.
    expect(saveLabel(after, INBOX)).toBe(SAVED_LABEL);
    vi.advanceTimersByTime(1500);
    expect(saveLabel(render(), INBOX)).toBe(SAVE_LABEL);
  });

  it('typing the shipped default verbatim drops the override and clears the badge', async () => {
    const before = render();
    typeInto(before, CAL, SERVICE_DESCRIPTIONS[CAL]);

    await click(saveButton(render(), CAL));
    await settle();

    expect(state.db[CAL]).toBeUndefined();
    const after = render();
    expect(blurb(after, CAL)).toBe(SERVICE_DESCRIPTIONS[CAL]);
    expect(badged(after, CAL)).toBe(false);
  });

  it('a refused reset says so and leaves the stored override on the screen', async () => {
    state.writeFails = true;
    const before = render();

    await click(resetButton(before, CAL));
    await settle();

    // Nothing was dropped, so the screen must keep showing the override.
    expect(state.db[CAL]).toBe('Our own calendar blurb.');
    const after = render();
    expect(blurb(after, CAL)).toBe('Our own calendar blurb.');
    expect(badged(after, CAL)).toBe(true);
    expect(header(after)).toContain(ONE_CUSTOMIZED);
    expect(state.error).toHaveBeenCalledTimes(1);
    expect(state.error).toHaveBeenCalledWith("You don't have permission to do that. Ask a family admin if you think this is a mistake.");
    expect(state.success).not.toHaveBeenCalled();
  });

  it('a refused reset gives back the unsaved text that was in the box, as a refused save would', async () => {
    state.writeFails = true;
    const before = render();
    typeInto(before, CAL, 'Half-written new blurb');
    const typed = render();
    expect(saveButton(typed, CAL).props.disabled).toBe(false);

    await click(resetButton(typed, CAL));
    await settle();

    // Nothing was applied, so nothing the admin had is gone: the override is
    // still stored and badged, and the typing is still in the box, still dirty.
    expect(state.db[CAL]).toBe('Our own calendar blurb.');
    const after = render();
    expect(blurb(after, CAL)).toBe('Half-written new blurb');
    expect(badged(after, CAL)).toBe(true);
    expect(saveButton(after, CAL).props.disabled).toBe(false);
    expect(state.error).toHaveBeenCalledTimes(1);
    expect(state.success).not.toHaveBeenCalled();

    // The same refusal on SAVE keeps the typing too — the two paths agree.
    await click(saveButton(after, CAL));
    await settle();
    expect(blurb(render(), CAL)).toBe('Half-written new blurb');
    expect(state.error).toHaveBeenCalledTimes(2);
  });

  it('the rollback of a refused reset does not overwrite what was typed while it was in flight', async () => {
    state.writeFails = true;
    const pending = click(resetButton(render(), CAL));
    // The box shows the optimistic default; the admin types over it before the refusal lands.
    expect(blurb(render(), CAL)).toBe(SERVICE_DESCRIPTIONS[CAL]);
    typeInto(render(), CAL, 'Typed during the round trip');
    await pending;
    await settle();

    expect(blurb(render(), CAL)).toBe('Typed during the round trip');
    expect(state.error).toHaveBeenCalledTimes(1);
  });

  it('a non-super-admin is refused and changes nothing', async () => {
    state.superAdmin = false;
    const before = render();

    await click(resetButton(before, CAL));
    await settle();

    expect(state.db[CAL]).toBe('Our own calendar blurb.');
    expect(state.error).toHaveBeenCalledWith(NOT_AUTHORIZED);
    expect(state.success).not.toHaveBeenCalled();
    expect(badged(render(), CAL)).toBe(true);
  });
});
