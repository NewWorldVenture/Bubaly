import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { nodes, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Actual MedicalRecordsModule/CardImage and getDocumentSignedUrl; only the SDK
// transport and app/UI boundary are synthetic. No Storage/Auth/provider calls.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const sdk = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock('react', async (original) => {
  const hooks = (await import('./helpers/hook-slots')).withHookSlots(await original<typeof import('react')>(), h.hooks);
  return { ...hooks, useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
    // The shared harness schedules effects; retain React's dependency cleanup
    // here so a superseded signing request is exercised faithfully too.
    const previous = hooks.useRef<void | (() => void)>(undefined);
    hooks.useEffect(() => { if (typeof previous.current === 'function') previous.current(); previous.current = run(); }, deps);
  } };
});
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return { createClient: () => { const client = clientFor(h); return { ...client, storage: { from: (name: string) => ({ ...client.storage.from(name), createSignedUrl: sdk.sign }) } }; } };
});
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/medical/print-sheet', () => ({ ProviderInfoSheet: () => null, CheckInSheet: () => null }));
const { MedicalRecordsModule } = await import('@/components/modules/medical-records-module');
const familyId = h.app.familyId;
const FIRST = familyId + '/insurance/first.jpg';
const NEXT = familyId + '/insurance/next.jpg';
const FIRST_URL = 'https://signed.invalid/first';
const NEXT_URL = 'https://signed.invalid/next';
const screen = () => render(h.hooks, createElement(MedicalRecordsModule, { kind: 'medical' }));
const images = () => nodes(screen()).filter(n => n.type === 'img').map(n => n.props.src);
const replacePath = (path: string | null) => { h.rows.insurance_policies = h.rows.insurance_policies.map(p => ({ ...p, front_image_path: path })); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  resetHookSlots(h.hooks); h.db = createInMemorySupabase(); h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() }; h.toasts = { success: [], error: [] };
  Object.assign(h.app, { role: 'parent' }); h.app.members = [{ id: 'parent', role: 'parent', display_name: 'Ada', user_id: 'user-1', is_active: true, color: null, birthday: null }]; h.app.selfMember = h.app.members[0];
  h.rows.insurance_policies = [{ id: 'policy', family_id: familyId, member_id: 'parent', kind: 'medical', insurer: 'Synthetic insurer', is_primary: true, front_image_path: FIRST, back_image_path: null }];
  sdk.sign.mockReset().mockResolvedValue({ data: { signedUrl: FIRST_URL }, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('insurance card signing reads', () => {
  it('renders a healthy signed card and keeps the private object path out of img src', async () => {
    screen(); await settle(); expect(images()).toEqual([FIRST_URL]); expect(sdk.sign).toHaveBeenCalledWith(FIRST, 600); expect(text(screen())).not.toContain('Unavailable');
  });
  it.each([
    ['explicit SDK refusal', { data: null, error: { message: 'synthetic refusal' } }],
    ['missing SDK data', { data: null, error: null }],
    ['missing signed URL', { data: {}, error: null }],
    ['empty signed URL', { data: { signedUrl: '' }, error: null }],
  ])('says the card is unavailable after %s rather than leaving its ordinary label', async (_name, response) => {
    sdk.sign.mockResolvedValue(response); screen(); await settle(); expect(images()).toEqual([]); expect(text(screen())).toContain('Unavailable');
  });
  it('also reports a thrown signing transport failure', async () => {
    sdk.sign.mockRejectedValue(new Error('synthetic network failure')); screen(); await settle(); expect(images()).toEqual([]); expect(text(screen())).toContain('Unavailable');
  });
  it('hides the previous card while the replacement path is still signing', async () => {
    screen(); await settle(); expect(images()).toEqual([FIRST_URL]);
    const next = deferred<{ data: { signedUrl: string }; error: null }>(); sdk.sign.mockReturnValue(next.promise); replacePath(NEXT);
    expect(images()).toEqual([]); next.resolve({ data: { signedUrl: NEXT_URL }, error: null }); await settle(); expect(images()).toEqual([NEXT_URL]);
  });
  it('does not restore an old card when its superseded signing promise completes late', async () => {
    const old = deferred<{ data: { signedUrl: string }; error: null }>(); sdk.sign.mockReturnValueOnce(old.promise); screen();
    sdk.sign.mockResolvedValue({ data: { signedUrl: NEXT_URL }, error: null }); replacePath(NEXT); screen(); await settle(); expect(images()).toEqual([NEXT_URL]);
    old.resolve({ data: { signedUrl: FIRST_URL }, error: null }); await settle(); expect(images()).toEqual([NEXT_URL]);
  });
  it('makes no signing request when no card path is present', async () => {
    h.rows.insurance_policies[0].front_image_path = null; screen(); await settle(); expect(images()).toEqual([]); expect(sdk.sign).not.toHaveBeenCalled();
  });
});
