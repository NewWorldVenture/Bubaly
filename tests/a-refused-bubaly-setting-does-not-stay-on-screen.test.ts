// Settings → Bubaly AI, the PANEL half: what components/settings/ai-settings.tsx
// leaves on screen when a save is refused.
//
// Every control on the panel edits FROM what the panel shows (the category
// picker sends the whole displayed map; a quiet-hours select fills the other
// end from the displayed value). A save is optimistic, so the moment a parent
// taps, the screen shows the change before the database has answered. When the
// database refuses it, the panel re-reads the row to put the truth back. And if
// that re-read ALSO fails, the only thing on screen is the refused guess — a
// family reading "Finances: Execute" that the database never accepted, and a
// parent whose next tap would send it again inside the next patch. So the panel
// must stop answering and say it could not load, rather than keep the guess.
//
// tests/the-bubaly-ai-page-never-passes-the-defaults-off-as-the-familys-settings.test.ts
// proves the action half (a failed read is an error, never the defaults). A
// static render never runs a handler, and the suite has no DOM, so this file
// drives the real panel through a hook-slot harness (the same one
// tests/a-moment-tap-saves-only-what-it-knows.test.ts uses) and asserts what is
// on screen after each answer.
import { isValidElement, createElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CATEGORY_BY_DOMAIN } from '@/lib/ai/categories';
import type { AISettings } from '@/lib/ai/family-settings';

// The REAL en-US catalogue: the sentence the load action answers with is
// asserted as the English the family reads, not as a key.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const COULD_NOT_LOAD = MESSAGES['aiActions.couldNotLoadYourBubaly'];
const COULD_NOT_SAVE = MESSAGES['aiActions.couldNotSaveThoseSettings'];

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effectsRun: [] as boolean[],
  effectCursor: 0,
  load: vi.fn(),
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => {
      state.slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(state.slots[index]) : value;
    }];
  },
  // Mount-only effects, run once — the panel's only effect is its first load.
  useEffect: (fn: () => unknown) => {
    const index = state.effectCursor++;
    if (state.effectsRun[index]) return;
    state.effectsRun[index] = true;
    fn();
  },
  useCallback: (fn: unknown) => fn,
}));

vi.mock('@/app/(app)/dashboard/settings/ai-actions', () => ({
  loadAISettingsAction: state.load,
  saveAISettingsAction: state.save,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: state.success, error: state.error }) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => MESSAGES[key] ?? key,
}));
// The memory panel loads its own data through its own actions; it is not what
// this file is about.
vi.mock('@/components/settings/ai-memory', () => ({ AIMemoryPanel: () => null }));

const { AISettingsPanel } = await import('@/components/settings/ai-settings');

type Node = ReactElement<Record<string, unknown>>;

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === 'function') return expand((node.type as (props: unknown) => ReactNode)(node.props));
  return createElement(node.type, { ...node.props, key: node.key }, expand(node.props.children as ReactNode));
}
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render(): ReactNode {
  state.cursor = 0;
  state.effectCursor = 0;
  return expand(AISettingsPanel({ role: 'parent' }));
}
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const FINANCES = `${AI_CATEGORY_BY_DOMAIN.finances.label} autonomy`;

/** The level the Finances picker shows as chosen, or null when it is not on screen. */
function financesShown(tree: ReactNode): string | null {
  const group = nodes(tree).find((n) => n.props.role === 'radiogroup' && n.props['aria-label'] === FINANCES);
  if (!group) return null;
  const checked = nodes(group.props.children as ReactNode).find((n) => n.props.role === 'radio' && n.props['aria-checked'] === true);
  return checked ? text(checked).trim() : null;
}
function financesButton(tree: ReactNode, level: string): Node {
  const group = nodes(tree).find((n) => n.props.role === 'radiogroup' && n.props['aria-label'] === FINANCES);
  const found = group && nodes(group.props.children as ReactNode).find((n) => n.props.role === 'radio' && text(n).trim() === level);
  if (!found) throw new Error(`No "${level}" on the Finances picker`);
  return found;
}

/** A family that keeps Bubaly on Recommend for money. */
const THE_RIVERAS: AISettings = {
  familyId: 'fam-1',
  enabled: true,
  behavior: 'prepare',
  categoryBehavior: { finances: 'recommend' },
  riskOverrides: {},
  childChannels: {},
  memoryEnabled: true,
  quietHours: { start: 21, end: 6 },
};

beforeEach(() => {
  state.slots = [];
  state.effectsRun = [];
  for (const fn of [state.load, state.save, state.success, state.error]) fn.mockReset();
  state.save.mockResolvedValue({ ok: false, error: COULD_NOT_SAVE });
});

/** Mount the panel over a first load that reads the Riveras' row. */
async function mountLoaded(): Promise<ReactNode> {
  state.load.mockResolvedValueOnce({ ok: true, settings: THE_RIVERAS });
  render();
  await settle();
  const tree = render();
  expect(financesShown(tree), 'the harness mounted the real panel on the real row').toBe('Recommend');
  return tree;
}

describe('the Bubaly AI panel when a save is refused', () => {
  it('the catalogue carries the two sentences asserted here', () => {
    expect(COULD_NOT_LOAD).toBe('Could not load your Bubaly settings.');
    expect(COULD_NOT_SAVE).toBe('Could not save those settings.');
  });

  it('does not keep the refused change on screen when the re-read fails too — it says it could not load', async () => {
    const tree = await mountLoaded();
    state.load.mockResolvedValueOnce({ ok: false, error: COULD_NOT_LOAD });

    await (financesButton(tree, 'Execute').props.onClick as () => Promise<void>)();
    await settle();

    expect(state.save).toHaveBeenCalledWith({ categoryBehavior: { finances: 'execute' } });
    expect(state.error, 'the refusal is reported').toHaveBeenCalledWith(COULD_NOT_SAVE);
    expect(state.load, 'the panel tried to put the truth back').toHaveBeenCalledTimes(2);

    const after = render();
    // The guess the database refused is gone, and so is every control that
    // would edit from it.
    expect(financesShown(after), 'Finances is not left showing the refused Execute').toBeNull();
    expect(nodes(after).filter((n) => n.props.role === 'radiogroup')).toHaveLength(0);
    expect(nodes(after).filter((n) => n.type === 'select')).toHaveLength(0);
    expect(text(after)).toContain(COULD_NOT_LOAD);
  });

  it('shows what the database really holds when the re-read works', async () => {
    const tree = await mountLoaded();
    state.load.mockResolvedValueOnce({ ok: true, settings: THE_RIVERAS });

    await (financesButton(tree, 'Execute').props.onClick as () => Promise<void>)();
    await settle();

    expect(state.error).toHaveBeenCalledWith(COULD_NOT_SAVE);
    expect(financesShown(render()), 'back on the level the row really has').toBe('Recommend');
  });
});

describe('the Bubaly AI panel when the first read fails', () => {
  it('shows the load error and no controls — not a default the family never chose', async () => {
    state.load.mockResolvedValueOnce({ ok: false, error: COULD_NOT_LOAD });
    render();
    await settle();

    const tree = render();
    expect(text(tree)).toContain(COULD_NOT_LOAD);
    expect(nodes(tree).filter((n) => n.props.role === 'radiogroup')).toHaveLength(0);
    expect(state.save).not.toHaveBeenCalled();
  });
});
