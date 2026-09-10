import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefingModule } from '@/components/modules/briefing-module';
import type { BriefingResponse } from '@/lib/briefing/cache-isolation';
import type { LocaleCode } from '@/lib/i18n/locales';
type Instance = {
    slots: unknown[];
    cursor: number;
    effects: (() => void)[];
};
type Effect = {
    deps: unknown[];
    cleanup?: () => void;
};
const mock = vi.hoisted(() => ({ active: null as unknown as Instance, locale: 'en-US' as LocaleCode, context: null as unknown, fetch: vi.fn<typeof fetch>(), getItem: vi.fn(), setItem: vi.fn() }));
// Actual parent/scoped component callbacks and the real session store. Separate
// hook lifetimes follow the rendered React key; the browser fixture tests React DOM.
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => { const state = mock.active, index = state.cursor++; if (!(index in state.slots))
        state.slots[index] = typeof initial === 'function' ? initial() : initial; return [state.slots[index], (value: unknown) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value; }]; },
    useMemo: (factory: () => unknown, deps: unknown[]) => { const state = mock.active, index = state.cursor++, old = state.slots[index] as {
        value: unknown;
        deps: unknown[];
    } | undefined; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i])))
        state.slots[index] = { value: factory(), deps }; return (state.slots[index] as {
        value: unknown;
    }).value; },
    useEffect: (effect: () => undefined | (() => void), deps: unknown[]) => { const state = mock.active, index = state.cursor++, old = state.slots[index] as Effect | undefined; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i])))
        state.effects.push(() => { old?.cleanup?.(); state.slots[index] = { deps, cleanup: effect() }; }); },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => mock.context }));
vi.mock('@/components/i18n/locale-provider', async () => { const { getMessages, translate } = await import('@/lib/i18n/messages'); const { localeOrDefault } = await import('@/lib/i18n/locales'); return { useLocale: () => localeOrDefault(mock.locale), useTranslations: () => (key: string) => translate(getMessages(mock.locale), key) }; });
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: [], error: null, refresh: vi.fn() }) }));
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
const context = { familyId: 'family-a', userId: 'user-a', role: 'parent', isSuperAdmin: false, planLevel: 2, featureTiers: {}, members: [], selfMember: { id: 'member-a', family_id: 'family-a', user_id: 'user-a', role: 'parent', is_active: true, updated_at: '2026-09-10T00:00:00Z' } };
function payload(greeting: string): BriefingResponse { return { generatedAt: '2026-09-10T12:00:00Z', briefing: { greeting, subtitle: greeting + ' subtitle', familySummary: [greeting + ' summary'], schedule: [], conflicts: [], kidsNeeds: [], meals: [], reminders: [], operationsScore: { overall: 90, categories: [], stressLevel: 'low', stressReason: null, recommendation: greeting + ' tip' } }, digest: { headline: greeting + ' digest', items: [], counts: { overdue: 0, today: 0, soon: 0, total: 0 }, byDomain: [] } }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const reply = (greeting: string) => new Response(JSON.stringify(payload(greeting)), { headers: { 'Content-Type': 'application/json' } });
const instance = (): Instance => ({ slots: [], cursor: 0, effects: [] });
function invoke(state: Instance, component: (props: never) => ReactNode, props: unknown) { mock.active = state; state.cursor = 0; const tree = component(props as never); state.effects.splice(0).forEach(effect => effect()); return tree; }
function unmount(state?: Instance) { for (const slot of state?.slots ?? [])
    if (slot && typeof slot === 'object' && 'cleanup' in slot)
        (slot as Effect).cleanup?.(); }
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join('') : isValidElement<{
    children?: ReactNode;
}>(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : []; }
let parent: Instance, child: Instance | undefined, key: string | null | undefined, entries: Map<string, string>;
function draw() { const boundary = invoke(parent, BriefingModule, {}) as Node; if (typeof boundary.type !== 'function')
    throw new Error('Missing boundary'); if (!child || key !== boundary.key) {
    unmount(child);
    child = instance();
    key = boundary.key;
} return invoke(child, boundary.type as (props: never) => ReactNode, boundary.props); }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(new Date('2026-09-10T12:00:00Z')); parent = instance(); child = undefined; key = undefined; mock.context = { ...context, selfMember: { ...context.selfMember } }; mock.locale = 'en-US'; mock.fetch.mockReset(); mock.getItem.mockReset(); mock.setItem.mockReset(); entries = new Map([['fos_briefing_morning_2026-09-10', 'private old snapshot'], ['unrelated', 'keep']]); vi.stubGlobal('fetch', mock.fetch); vi.stubGlobal('window', { sessionStorage: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, removeItem: (key: string) => entries.delete(key), getItem: mock.getItem, setItem: mock.setItem } }); });
afterEach(() => { unmount(child); unmount(parent); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('mounted briefing locale isolation', () => {
    it('hides completed briefing and digest immediately for a different locale and returning to the first locale', async () => {
        mock.fetch.mockResolvedValueOnce(reply('English private brief')).mockImplementation(() => new Promise(() => { }));
        draw();
        await vi.waitFor(() => expect(text(draw())).toContain('English private brief'));
        expect(nodes(draw()).some(node => (node.props.digest as {
            headline?: string;
        } | undefined)?.headline === 'English private brief digest')).toBe(true);
        mock.locale = 'fr-FR';
        expect(text(draw())).not.toContain('English private brief');
        expect(nodes(draw()).some(node => node.props.digest)).toBe(false);
        expect(mock.fetch).toHaveBeenCalledTimes(2);
        mock.locale = 'en-US';
        expect(text(draw())).not.toContain('English private brief');
        expect(mock.fetch).toHaveBeenCalledTimes(3);
        expect(mock.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
        expect([...entries]).toEqual([['unrelated', 'keep']]);
        expect(mock.getItem).not.toHaveBeenCalled();
        expect(mock.setItem).not.toHaveBeenCalled();
    });
    it.each(['success', 'failure', 'body'] as const)('aborts and ignores old %s across locale ABA without clearing the current request', async (kind) => {
        const old = deferred<Response>(), body = deferred<unknown>(), middle = deferred<Response>(), current = deferred<Response>();
        mock.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(current.promise);
        draw();
        if (kind === 'body') {
            old.resolve({ ok: true, json: () => body.promise } as Response);
            await flush();
        }
        mock.locale = 'fr-FR';
        draw();
        mock.locale = 'en-US';
        draw();
        expect(mock.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(mock.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
        if (kind === 'failure')
            old.reject(new Error('Old localized error'));
        else if (kind === 'body')
            body.resolve(payload('Old English'));
        else
            old.resolve(reply('Old English'));
        await flush();
        expect(text(draw())).not.toMatch(/Old English|Old localized error/);
        expect(nodes(draw()).find(node => typeof node.type === 'function' && node.type.name === 'GenerateCTA')?.props.loading).toBe(true);
        current.resolve(reply('New English'));
        await vi.waitFor(() => expect(text(draw())).toContain('New English'));
        expect(text(draw())).not.toMatch(/Old English|Old localized error/);
        for (const [, options] of mock.fetch.mock.calls)
            expect(options).toMatchObject({ cache: 'no-store', body: JSON.stringify({ type: 'morning' }) });
    });
    it('clears a completed old-language error and retries the new language once', async () => {
        mock.fetch.mockRejectedValueOnce(new Error('English only failure')).mockResolvedValueOnce(reply('Nouvelle réponse'));
        draw();
        await vi.waitFor(() => expect(text(draw())).toContain('English only failure'));
        mock.locale = 'fr-FR';
        expect(text(draw())).not.toContain('English only failure');
        await vi.waitFor(() => expect(text(draw())).toContain('Nouvelle réponse'));
        expect(mock.fetch).toHaveBeenCalledTimes(2);
    });
    it('keeps equivalent locale/context rerenders stable while member and entitlement changes still revoke data', async () => {
        mock.fetch.mockResolvedValueOnce(reply('Private member result')).mockImplementation(() => new Promise(() => { }));
        draw();
        await vi.waitFor(() => expect(text(draw())).toContain('Private member result'));
        mock.context = { ...context, selfMember: { ...context.selfMember } };
        expect(text(draw())).toContain('Private member result');
        expect(mock.fetch).toHaveBeenCalledTimes(1);
        mock.context = { ...context, selfMember: { ...context.selfMember, updated_at: '2026-09-10T12:01:00Z' } };
        expect(text(draw())).not.toContain('Private member result');
        expect(mock.fetch).toHaveBeenCalledTimes(2);
        mock.context = { ...context, role: 'child', planLevel: 0, featureTiers: { '/dashboard/briefing': 'off' }, selfMember: { ...context.selfMember, role: 'child' } };
        draw();
        expect(mock.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
        expect(mock.fetch).toHaveBeenCalledTimes(3);
    });
});
