import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentLinkCapture } from '@/components/capture/document-link-capture';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], locale: 'en-US' as LocaleCode, send: vi.fn(), familyId: 'family-1', userId: 'user-1' }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = state.cursor++;
    if (!(i in state.slots)) state.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[i], (value: unknown) => { state.slots[i] = typeof value === 'function' ? value(state.slots[i]) : value; }];
  },
  useRef: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = { current: initial }; return state.slots[i]; },
  useEffect: (effect: () => (() => void), deps: unknown[]) => {
    const i = state.cursor++;
    const previous = state.slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!previous || deps.some((dep, index) => dep !== previous.deps[index])) {
      const next = { deps, setup: effect, cleanup: undefined as (() => void) | undefined }; state.slots[i] = next;
      state.effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
    }
  },
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: state.familyId, userId: state.userId }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => translate(getMessages(state.locale), key) }));
vi.mock('@/lib/capture/document-link', async (original) => ({ ...await original<typeof import('@/lib/capture/document-link')>(), importDocumentLink: state.send }));
type Node = ReactElement<Record<string, unknown>>;
const props = { expectedFamilyId: 'family-1', expectedUserId: 'user-1', initialUrl: 'https://school.org/form.pdf' };
const saved = { ok: true, data: { id: '10000000-0000-4000-8000-000000000001', partial: false } };
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const t = (key: string) => translate(getMessages(state.locale), `documentLink.${key}`);
function render(extra: Partial<Parameters<typeof DocumentLinkCapture>[0]> = {}, effects = true) {
  state.cursor = 0; const tree = DocumentLinkCapture({ ...props, ...extra });
  if (effects) state.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function button(tree: ReactNode, key: string) {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node) === t(key));
  if (!found) throw new Error(`Missing ${key}`);
  return found;
}
const click = (node: Node) => (node.props.onClick as () => void)();
beforeEach(() => { state.slots = []; state.cursor = 0; state.effects = []; state.locale = 'en-US'; state.send.mockReset(); state.familyId = 'family-1'; state.userId = 'user-1'; });

describe('explicit linked-document controls', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('shows format/size/manual-only policy in %s without fetching on render', (locale) => {
    state.locale = locale;
    const tree = render();
    expect(text(tree)).toContain(t('description')); expect(text(tree)).toContain(t('policy'));
    expect(button(tree, 'import').props.disabled).toBe(false);
    expect(nodes(tree).find((node) => node.type === 'input')?.props.value).toBe(props.initialUrl);
    expect(state.send).not.toHaveBeenCalled();
  });
  it('blocks two same-frame clicks synchronously and preserves the same receipt through explicit retry', async () => {
    let finish: (value: unknown) => void = () => {};
    state.send.mockImplementation(() => new Promise((done) => { finish = done; }));
    const trigger = button(render(), 'import');
    click(trigger); click(trigger);
    expect(state.send).toHaveBeenCalledTimes(1);
    const initial = state.send.mock.calls[0][0];
    finish({ ok: false, reason: 'unavailable', retryable: true });
    await vi.waitFor(() => expect(text(render())).toContain(t('unavailable')));
    state.send.mockResolvedValue(saved);
    click(button(render(), 'retry'));
    await vi.waitFor(() => expect(text(render())).toContain(t('saved')));
    expect(state.send.mock.calls[1][0]).toEqual(initial);
  });
  it('remains usable after StrictMode-equivalent setup, cleanup and setup replay', async () => {
    const tree = render();
    for (const slot of state.slots) {
      const effect = slot as { setup?: () => (() => void); cleanup?: () => void } | null;
      if (effect?.setup) { effect.cleanup?.(); effect.cleanup = effect.setup(); }
    }
    state.send.mockResolvedValue(saved);
    click(button(tree, 'import'));
    expect(state.send).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(text(render())).toContain(t('saved')));
  });
  it('allows a new selection after switching A to B to A without a stale cleanup disabling Import', async () => {
    render();
    state.familyId = 'family-2'; render();
    state.familyId = 'family-1'; render();
    const input = nodes(render()).find((node) => node.type === 'input')!;
    (input.props.onChange as (event: unknown) => void)({ target: { value: 'https://school.org/new.txt' } });
    state.send.mockResolvedValue(saved); click(button(render(), 'import'));
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][0].url).toBe('https://school.org/new.txt');
    await vi.waitFor(() => expect(text(render())).toContain(t('saved')));
  });
  it('retains saved-text receipt and locks selection while enrichment needs retry', async () => {
    state.send.mockResolvedValue({ ok: false, reason: 'unavailable', saved: true, retryable: true });
    click(button(render(), 'import'));
    await vi.waitFor(() => expect(text(render())).toContain(t('saved_retry')));
    expect(nodes(render()).find((node) => node.type === 'input')?.props.disabled).toBe(true);
    expect(button(render(), 'retry').props.disabled).toBe(false);
  });
  it.each(['familyId', 'userId'] as const)('suppresses old URL and result immediately on %s change, even before passive cleanup', async (key) => {
    let finish: (value: unknown) => void = () => {};
    state.send.mockImplementation(() => new Promise((done) => { finish = done; }));
    const original = render();
    const oldInput = nodes(original).find((node) => node.type === 'input')!;
    const oldButton = button(original, 'import'); click(oldButton);
    state[key] = 'new-context';
    const fresh = render({}, false);
    expect(nodes(fresh).some((node) => node.type === 'input')).toBe(false);
    expect(text(fresh)).toContain(t('context_changed'));
    (oldInput.props.onChange as (event: unknown) => void)({ target: { value: 'https://old.org/secret' } });
    click(oldButton);
    finish(saved); await Promise.resolve(); await Promise.resolve();
    expect(text(render({}, false))).not.toContain(t('saved'));
    expect(state.send).toHaveBeenCalledTimes(1);
  });
  it('aborts on reset and ignores a response for the prior selection', async () => {
    let finish: (value: unknown) => void = () => {};
    state.send.mockImplementation(() => new Promise((done) => { finish = done; }));
    click(button(render(), 'import'));
    const signal = state.send.mock.calls[0][1] as AbortSignal;
    click(button(render(), 'reset'));
    expect(signal.aborted).toBe(true);
    finish(saved); await Promise.resolve(); await Promise.resolve();
    expect(nodes(render()).find((node) => node.type === 'input')?.props.value).toBe('');
    expect(text(render())).not.toContain(t('saved'));
  });
  it('rejects retained Import and input handlers after Reset changes the selection before another render', async () => {
    state.send.mockResolvedValue({ ok: false, reason: 'unavailable', retryable: true });
    click(button(render(), 'import'));
    await vi.waitFor(() => expect(text(render())).toContain(t('unavailable')));
    const old = render();
    click(button(old, 'reset'));
    click(button(old, 'retry'));
    const oldInput = nodes(old).find((node) => node.type === 'input')!;
    (oldInput.props.onChange as (event: unknown) => void)({ target: { value: 'https://old.org/stale.txt' } });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(nodes(render()).find((node) => node.type === 'input')?.props.value).toBe('');
  });
  it('requires choosing an inbound candidate, sends its message ID, and never fetches all links', async () => {
    const inbound = { messageId: 'mail-1', candidates: ['https://school.org/a', 'https://school.org/b'], initialUrl: '' };
    const tree = render(inbound);
    expect(button(tree, 'import').props.disabled).toBe(true);
    const select = nodes(tree).find((node) => node.type === 'select')!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: inbound.candidates[1] } });
    state.send.mockResolvedValue(saved); click(button(render(inbound), 'import'));
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][0]).toMatchObject({ messageId: 'mail-1', url: inbound.candidates[1], familyId: 'family-1', userId: 'user-1' });
    await Promise.resolve();
  });
  it('shows partial review warning and a real Paperwork navigation target', async () => {
    state.send.mockResolvedValue({ ...saved, data: { ...saved.data, partial: true } });
    click(button(render(), 'import'));
    await vi.waitFor(() => expect(text(render())).toContain(t('partial')));
    expect(nodes(render()).find((node) => node.type === 'a')?.props.href).toBe(`/dashboard/paperwork#paperwork-${saved.data.id}`);
  });
  it('offers usable verification and terminal unsupported feedback without an automatic retry', async () => {
    state.send.mockResolvedValue({ ok: false, reason: 'step_up', retryable: false, stepUp: '/auth/step-up?next=%2Fcapture%2Flink' });
    click(button(render(), 'import'));
    await vi.waitFor(() => expect(text(render())).toContain(t('step_up')));
    expect(nodes(render()).find((node) => node.type === 'a')?.props.href).toBe('/auth/step-up?next=%2Fcapture%2Flink');
    expect(button(render(), 'import').props.disabled).toBe(true);
    expect(state.send).toHaveBeenCalledTimes(1);
  });
});
