// The Guardian routing form saves every row it lets a family change.
//
// It did not. The Routing Rules tab renders an editable row for six trust tiers
// — immediate family, close family, trusted friend, known contact, unknown,
// suspected spam — and `save()` listed three of them by hand:
//
//     default_mode_unknown, default_mode_known, default_mode_suspected_spam
//
// The server action accepted the same three. So NOTHING in the application ever
// wrote default_mode_immediate, default_mode_close or default_mode_trusted: the
// columns only ever held their DEFAULT, while resolveFromProfile in
// lib/guardian/pipeline.ts routes every inbound call from those three tiers
// through exactly those three columns. Changing one highlighted the new mode,
// answered "Settings saved", and reverted on the next load. A member who set
// immediate family to Silent — because of who is in that tier — kept being rung.
//
// Two more values could not be saved at all: `value || undefined` dropped a
// CLEARED greeting, so deleting a custom AI or voicemail greeting put the old
// text straight back.
//
// This drives the real component's real handlers — click a row, click Save — and
// asserts on what the server action was handed and what the payload builder
// would write. No source grepping: a field that never leaves the browser fails
// here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTING_MODE_LABELS, type RoutingMode } from '@/lib/guardian/pipeline';
import type { TrustLevel } from '@/lib/guardian/trust';
import {
  EDITABLE_TRUST_LEVELS, TRUST_TO_FIELD, guardianProfilePayload, routingDefaults, routingUpdate,
  type GuardianProfileWrite, type RoutingProfile, type RoutingProfileSource,
} from '@/lib/guardian/routing-form';

const harness = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  saved: [] as Record<string, unknown>[],
}));

// State that survives between renders, so a handler's effect is visible to the
// next one — the repository's existing pattern for driving a client component in
// the Node runner (see tests/contacts-localization.test.ts).
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = initial;
    return [harness.slots[index], (next: unknown) => {
      harness.slots[index] = typeof next === 'function'
        ? (next as (p: unknown) => unknown)(harness.slots[index])
        : next;
    }];
  },
}));
vi.mock('@/app/(app)/guardian/actions', () => ({
  upsertMemberProfileAction: async (input: Record<string, unknown>) => {
    harness.saved.push(input);
    return { ok: true };
  },
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en-US',
}));

const { RoutingSettings } = await import('@/components/guardian/routing-settings');

const MEMBER = { id: 'mem-1', display_name: 'Rosa' };

type El = {
  type: unknown;
  key: string | null;
  props: Record<string, unknown> & { children?: unknown; onClick?: () => unknown; onChange?: (e: unknown) => void };
};

const isElement = (node: unknown): node is El =>
  !!node && typeof node === 'object' && 'type' in (node as El) && 'props' in (node as El);

/**
 * Every element in the tree, function components called so their output is in
 * it too. Lucide icons are forwardRef objects rather than functions, so they
 * are left as leaves.
 */
function expand(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const child of node) expand(child, out); return out; }
  if (!isElement(node)) return out;
  out.push(node);
  if (typeof node.type === 'function') {
    expand((node.type as (props: unknown) => unknown)(node.props), out);
    return out;
  }
  expand(node.props.children, out);
  return out;
}

/** Render the form from scratch, keeping whatever state earlier clicks set. */
function render(source: RoutingProfileSource): El[] {
  harness.cursor = 0;
  return expand(RoutingSettings({ profile: source, member: MEMBER }));
}

const find = (tree: El[], match: (el: El) => boolean, what: string): El => {
  const hit = tree.find(match);
  if (!hit) throw new Error(`no ${what} in the rendered form`);
  return hit;
};

/** Click the mode button in one trust tier's row. Both are keyed, so no text. */
function chooseMode(tree: El[], trust: TrustLevel, mode: RoutingMode) {
  const row = find(tree, (el) => el.key === trust, `row for ${trust}`);
  const button = find(expand(row), (el) => el.type === 'button' && el.key === mode, `${mode} button for ${trust}`);
  (button.props.onClick as () => void)();
}

const saveButton = (tree: El[]) =>
  find(tree, (el) => el.type === 'button' && el.props.children === 'Save Settings', 'Save button');

const lastSave = () => harness.saved[harness.saved.length - 1] as GuardianProfileWrite;

const stored = (over: Partial<RoutingProfile> = {}): RoutingProfileSource => ({
  status: 'ok',
  profile: { ...routingDefaults(MEMBER.id), id: 'prof-1', ...over },
});

beforeEach(() => {
  harness.slots = [];
  harness.cursor = 0;
  harness.saved = [];
});

describe('every routing row the form shows reaches the column that routes the call', () => {
  // Six cases, not one: three of these fields had no writer anywhere in the
  // application, and a single all-at-once case would not say which.
  it.each(EDITABLE_TRUST_LEVELS)('saves the mode chosen for %s', async (trust) => {
    const field = TRUST_TO_FIELD[trust];
    // voicemail_first is not the default for any tier, so this is a real change
    // for every one of them.
    chooseMode(render(stored()), trust, 'voicemail_first');
    await (saveButton(render(stored())).props.onClick as () => Promise<void>)();

    expect(lastSave()[field]).toBe('voicemail_first');
    expect(guardianProfilePayload(lastSave(), 'fam-1')[field]).toBe('voicemail_first');
  });

  // And all six together, each to a DIFFERENT mode: a payload builder that
  // forwarded one field for all six would pass the cases above.
  it('saves six different modes to six different columns', async () => {
    const chosen: RoutingMode[] = [
      'immediate_ai_summary', 'voicemail_first', 'silent_handling',
      'blocked', 'immediate_ring', 'ai_handle_first',
    ];
    EDITABLE_TRUST_LEVELS.forEach((trust, i) => chooseMode(render(stored()), trust, chosen[i]));
    await (saveButton(render(stored())).props.onClick as () => Promise<void>)();

    const payload = guardianProfilePayload(lastSave(), 'fam-1');
    EDITABLE_TRUST_LEVELS.forEach((trust, i) => {
      expect(payload[TRUST_TO_FIELD[trust]], `${trust} → ${TRUST_TO_FIELD[trust]}`).toBe(chosen[i]);
    });
  });

  it('sends the family to the right row and the right member', async () => {
    await (saveButton(render(stored())).props.onClick as () => Promise<void>)();
    expect(guardianProfilePayload(lastSave(), 'fam-1')).toMatchObject({
      family_id: 'fam-1',
      member_id: MEMBER.id,
    });
  });

  it('keeps saving the context overrides it always saved', async () => {
    const tree = render(stored());
    const persona = find(tree, (el) => el.type === 'button' && el.key === 'context', 'context tab');
    (persona.props.onClick as () => void)();
    const withTab = render(stored());
    const row = find(withTab, (el) => el.key === 'driving', 'driving row');
    const button = find(expand(row), (el) => el.type === 'button' && el.key === 'blocked', 'blocked button');
    (button.props.onClick as () => void)();
    await (saveButton(render(stored())).props.onClick as () => Promise<void>)();

    expect((lastSave().context_overrides ?? {}).driving).toBe('blocked');
  });
});

describe('a greeting a family deleted stays deleted', () => {
  /** Switch to the persona tab and type `value` into the field showing `showing`. */
  async function retype(showing: string, value: string, source: RoutingProfileSource) {
    const tab = find(render(source), (el) => el.type === 'button' && el.key === 'persona', 'persona tab');
    (tab.props.onClick as () => void)();
    const field = find(render(source), (el) => el.props.value === showing, `field showing "${showing}"`);
    (field.props.onChange as (e: unknown) => void)({ target: { value } });
    await (saveButton(render(source)).props.onClick as () => Promise<void>)();
  }

  it('clears the AI greeting instead of putting the old text back', async () => {
    await retype('Hello from us', '', stored({ ai_greeting_template: 'Hello from us' }));
    // The KEY has to be present: omitting it leaves the column untouched, which
    // is how "delete this greeting" used to mean "keep it".
    expect(Object.keys(lastSave())).toContain('ai_greeting_template');
    expect(lastSave().ai_greeting_template).toBeNull();
    expect(guardianProfilePayload(lastSave(), 'fam-1').ai_greeting_template).toBeNull();
  });

  it('clears the voicemail greeting too', async () => {
    await retype('Leave a message', '', stored({ voicemail_greeting: 'Leave a message' }));
    expect(lastSave().voicemail_greeting).toBeNull();
  });

  // Whitespace is not a greeting. Without this, "  " would be stored and read
  // back as a custom greeting that says nothing.
  it('treats a whitespace-only greeting as cleared', async () => {
    await retype('Hello from us', '   ', stored({ ai_greeting_template: 'Hello from us' }));
    expect(lastSave().ai_greeting_template).toBeNull();
  });

  // The negative control: clearing must not be the only thing that works.
  it('saves a greeting the family actually typed', async () => {
    await retype('Hello from us', 'You have reached the Riveras', stored({ ai_greeting_template: 'Hello from us' }));
    expect(lastSave().ai_greeting_template).toBe('You have reached the Riveras');
  });
});

describe('the payload writes what the caller sent, and nothing else', () => {
  // An upsert writes every column in the payload, so a key the caller never sent
  // would blank a column. updateContextAction sends only current_context.
  it('leaves out every column the caller did not name', () => {
    const payload = guardianProfilePayload({ member_id: 'mem-1', current_context: 'driving' }, 'fam-1');
    expect(Object.keys(payload).sort()).toEqual(['current_context', 'family_id', 'member_id']);
  });

  it('carries every routing column the form can edit', () => {
    const payload = guardianProfilePayload(routingUpdate(routingDefaults('mem-1'), 'mem-1'), 'fam-1');
    for (const trust of EDITABLE_TRUST_LEVELS) {
      expect(Object.keys(payload), `${TRUST_TO_FIELD[trust]} is editable and must be writable`)
        .toContain(TRUST_TO_FIELD[trust]);
    }
  });

  // blocked is the one tier with no editable row, so the form must not send it:
  // a blocked caller is blocked, and that is not a routing preference.
  it('does not send a mode for a tier the form gives no row', () => {
    expect(Object.keys(routingUpdate(routingDefaults('mem-1'), 'mem-1'))).not.toContain('default_mode_blocked');
  });

  it('names every mode the form offers, so no row can select an unsavable one', () => {
    // Guards the other direction: a seventh routing mode added to ROUTING_MODE_LABELS
    // renders a button in every row, and this says it has somewhere to go.
    const modes = Object.keys(ROUTING_MODE_LABELS) as RoutingMode[];
    for (const trust of EDITABLE_TRUST_LEVELS) {
      for (const mode of modes) {
        const form = { ...routingDefaults('mem-1'), [TRUST_TO_FIELD[trust]]: mode };
        expect(routingUpdate(form, 'mem-1')[TRUST_TO_FIELD[trust]]).toBe(mode);
      }
    }
  });
});
