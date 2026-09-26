import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentCapture } from '@/components/capture/document-capture';
import { PaperworkModule } from '@/components/modules/paperwork-module';
import { CameraCapture } from '@/components/ui/camera-capture';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[], locale: 'en-US' as LocaleCode, upload: vi.fn(), refresh: vi.fn(), familyId: 'family-1', userId: 'parent-1' }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }];
  },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useMemo: (fn: () => unknown) => fn(),
  useTransition: () => [false, (fn: () => void) => fn()],
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = state.cursor++;
    const previous = state.slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
      state.effects.push(effect); state.slots[index] = deps;
    }
  },
}));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => translate(getMessages(state.locale), key) }));
vi.mock('@/lib/capture/document-upload', async (original) => ({ ...await original<typeof import('@/lib/capture/document-upload')>(), uploadCapturedDocument: state.upload }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: state.refresh }) }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: state.familyId, userId: state.userId, selfMember: { id: 'member-1' } }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/app/(app)/dashboard/paperwork/actions', () => ({ addPaperworkAction: vi.fn(), materializePaperworkActionAction: vi.fn(), setPaperworkStatusAction: vi.fn(), draftPaperworkReplyAction: vi.fn() }));
vi.mock('@/app/(app)/capture/shortcuts-actions', () => ({ saveCaptureShortcutsAction: vi.fn() }));
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render(props: Partial<Parameters<typeof DocumentCapture>[0]> = {}) {
  state.cursor = 0;
  const tree = DocumentCapture({ photo: true, ...props });
  state.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).find((node) => node.type === 'button' && textOf(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const click = (node: Node) => (node.props.onClick as () => void)();
const t = (key: string) => getMessages(state.locale)[key];
const document = () => new File(['%PDF-1.7\nform'], '<school>.pdf', { type: 'application/pdf' });
function select(file = document()) {
  const input = nodes(render()).find((node) => node.type === 'input' && node.props.type === 'file')!;
  (input.props.onChange as (event: unknown) => void)({ target: { files: [file], value: 'chosen' } });
  return file;
}
beforeEach(() => { state.slots = []; state.cursor = 0; state.effects = []; state.locale = 'en-US'; state.upload.mockReset(); state.refresh.mockReset(); state.familyId = 'family-1'; state.userId = 'parent-1'; });

describe('document capture controls', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('renders document types, limits and controls in %s', (locale) => {
    state.locale = locale;
    const tree = render();
    expect(textOf(tree)).toContain(t('documentCapture.description'));
    expect(button(tree, t('documentCapture.choose'))).toBeDefined();
    const input = nodes(tree).find((node) => node.props.type === 'file')!;
    expect(input.props.accept).toContain('application/pdf');
    expect(input.props.capture).toBe('environment');
    expect(state.upload).not.toHaveBeenCalled();
  });

  it('retains the selected file and capture identity through explicit retries', async () => {
    const file = select();
    state.upload.mockResolvedValueOnce({ ok: false, reason: 'provider_unavailable', retryable: true });
    click(button(render(), t('documentCapture.save')));
    await vi.waitFor(() => expect(textOf(render())).toContain(t('documentCapture.provider_unavailable')));
    expect(textOf(render())).toContain(file.name);
    const first = state.upload.mock.calls[0][0];
    expect(first.file).toBe(file);
    state.upload.mockResolvedValueOnce({ ok: true, data: { id: '20000000-0000-4000-8000-000000000001', partial: true } });
    click(button(render(), t('timeSaved.tryAgain')));
    await vi.waitFor(() => expect(textOf(render())).toContain(t('documentCapture.saved')));
    expect(state.upload.mock.calls[1][0]).toMatchObject({ file, captureId: first.captureId, sender: first.sender, familyId: 'family-1', userId: 'parent-1' });
    expect(textOf(render())).toContain(t('paperwork.partialExtractionWarning'));
    expect(nodes(render()).find((node) => node.type === 'a')?.props.href).toBe('/dashboard/paperwork#paperwork-20000000-0000-4000-8000-000000000001');
  });

  it('offers saved-text retry after enrichment failure without asking for another selection', async () => {
    select();
    state.upload.mockResolvedValueOnce({ ok: false, reason: 'unavailable', retryable: true, saved: true });
    click(button(render(), t('documentCapture.save')));
    await vi.waitFor(() => expect(textOf(render())).toContain(t('documentCapture.savedRetry')));
    expect(button(render(), t('timeSaved.tryAgain')).props.disabled).toBe(false);
    expect(nodes(render()).find((node) => node.type === 'input' && node.props.maxLength === 200)?.props.disabled).toBe(true);
  });

  it('routes a camera capture through the same selection and explicit save flow', () => {
    click(button(render(), t('cameraCapture.takeAPhoto')));
    const camera = nodes(render()).find((node) => node.type === CameraCapture)!;
    const photo = new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });
    (camera.props.onCapture as (file: File) => void)(photo);
    expect(nodes(render()).some((node) => node.type === CameraCapture)).toBe(false);
    expect(textOf(render())).toContain('photo.jpg');
    expect(button(render(), t('documentCapture.save'))).toBeDefined();
    expect(state.upload).not.toHaveBeenCalled();
  });

  it('makes capture available from the Paperwork composer', () => {
    state.cursor = 0;
    click(button(PaperworkModule({ items: [] }), 'Add paperwork'));
    state.cursor = 0;
    expect(nodes(PaperworkModule({ items: [] })).some((node) => node.type === DocumentCapture)).toBe(true);
  });

  it.each(['familyId', 'userId'] as const)('hides prior selection immediately after a %s switch and ignores a late response', async (key) => {
    const file = select();
    let resolve: (value: unknown) => void = () => {};
    state.upload.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const onSaved = vi.fn();
    click(button(render({ onSaved }), t('documentCapture.save')));
    const pendingContext = state.upload.mock.calls[0][0];
    expect(pendingContext.isCurrent()).toBe(true);
    state[key] = 'other';
    expect(textOf(render({ onSaved }))).not.toContain(file.name);
    expect(pendingContext.isCurrent()).toBe(false);
    resolve({ ok: true, data: { id: '20000000-0000-4000-8000-000000000001', partial: false } });
    await Promise.resolve(); await Promise.resolve();
    expect(textOf(render({ onSaved }))).not.toContain(t('documentCapture.saved'));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows the verification destination when document assurance is required', async () => {
    select();
    state.upload.mockResolvedValueOnce({ ok: false, reason: 'step_up', retryable: false, stepUp: '/auth/step-up?next=%2Fdashboard%2Fpaperwork' });
    click(button(render(), t('documentCapture.save')));
    await vi.waitFor(() => expect(textOf(render())).toContain(t('documentCapture.step_up')));
    expect(nodes(render()).find((node) => node.type === 'a')?.props.href).toBe('/auth/step-up?next=%2Fdashboard%2Fpaperwork');
  });

  it('refreshes the Paperwork page and selects Needs action so the new review target is visible', () => {
    const item = { id: 'new-paper', family_id: 'family-1', title: 'Captured school form', kind: 'school_notice', status: 'needs_action', urgency: 'normal', actions: [], meta: {},
      raw_text: textOf('captured text'), summary: null, sender: null, due_on: null, amount: null, created_by: 'parent-1', created_at: '2026-09-09', updated_at: '2026-09-09' };
    state.cursor = 0;
    click(button(PaperworkModule({ items: [] }), 'Done'));
    state.cursor = 0;
    click(button(PaperworkModule({ items: [] }), 'Add paperwork'));
    state.cursor = 0;
    const composer = nodes(PaperworkModule({ items: [] })).find((node) => node.type === DocumentCapture)!;
    (composer.props.onSaved as () => void)();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    state.cursor = 0;
    expect(nodes(PaperworkModule({ items: [item] })).some((node) => node.type === 'article' && node.props.id === 'paperwork-new-paper')).toBe(true);
  });
});
