// saveAIConfigAction and testAIConnectionAction (app/(app)/admin/ai/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. The AI engine's model and API key are platform settings in
// app_settings, not family data: a household's roles say nothing about them and
// there is no "other family" to reach. Both actions are gated by superAdminGate
// (lib/auth/super-admin-gate.ts:31-42; app/(app)/admin/ai/actions.ts:15 and :55),
// which allows only a super admin whose session has passed two-step
// (lib/auth/super-admin-assurance.ts). A refusal is an ANSWER, never a throw.
//
// WHAT IS ASSERTED: the super admin's save writes the ai_provider row and one
// site-admin audit row that records only WHETHER a key changed; the super
// admin's connection test reaches the scripted provider (AI_PROVIDER_STUB=1,
// tests only) and reports its reply. Every other caller gets the action's own
// refusal and every table of both households is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTranslations: async () => (key: string) => key,
}));

const { saveAIConfigAction, testAIConnectionAction } = await import('@/app/(app)/admin/ai/actions');

const SAVE = 'ACTION-64B952BDF516';
const TEST = 'ACTION-3AB7DB1EA5AD';
const FIXTURE_KEY = 'sk-fixture-not-a-real-key';
let db: InMemorySupabase;

const form = (model: string, openaiKey: string) => {
  const fd = new FormData();
  fd.set('model', model);
  fd.set('openaiKey', openaiKey);
  return fd;
};

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  db.seed('app_settings', [{ key: 'ai_provider', value: { provider: 'openai', model: 'gpt-old', openaiKey: 'sk-stored-fixture' }, updated_by: null }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe(`${SAVE} saveAIConfigAction`, () => {
  it(`${SAVE} a super admin saves the model and key, and the audit row says only that the key changed`, async () => {
    signInAs({ kind: 'super_admin' });
    expect(await saveAIConfigAction(form('gpt-new', FIXTURE_KEY))).toEqual({ ok: true });
    expect(db.table('app_settings')).toEqual([
      expect.objectContaining({
        key: 'ai_provider', updated_by: SUPER_ADMIN.id,
        value: expect.objectContaining({ provider: 'openai', model: 'gpt-new', openaiKey: FIXTURE_KEY }),
      }),
    ]);
    const audit = db.table('audit_logs');
    expect(audit).toEqual([expect.objectContaining({
      family_id: null, actor_id: SUPER_ADMIN.id, action: 'update', resource: 'app_settings',
      metadata: expect.objectContaining({ setting_key: 'ai_provider', model: 'gpt-new', key_changed: true, via: 'site_admin' }),
    })]);
    expect(JSON.stringify(audit)).not.toContain(FIXTURE_KEY);
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/ai');
  });

  it(`${SAVE} a super admin's blank key keeps the stored one`, async () => {
    signInAs({ kind: 'super_admin' });
    expect(await saveAIConfigAction(form('gpt-new', ''))).toEqual({ ok: true });
    expect(db.table('app_settings')[0].value).toEqual(expect.objectContaining({ model: 'gpt-new', openaiKey: 'sk-stored-fixture' }));
    expect(db.table('audit_logs')[0].metadata).toEqual(expect.objectContaining({ key_changed: false }));
  });

  it.each(REFUSED_CALLERS)(`${SAVE} $label is refused and nothing is written`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    expect(await saveAIConfigAction(form('gpt-new', FIXTURE_KEY))).toEqual({
      ok: false, error: status === 403 && caller.kind === 'admin_owes_code' ? 'actions.adminConsoleNeedsYourCode' : 'actions.forbidden',
    });
    expect(snapshot(db)).toEqual(before);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${TEST} testAIConnectionAction`, () => {
  it(`${TEST} a super admin's test reaches the (scripted) provider and reports its reply`, async () => {
    vi.stubEnv('AI_PROVIDER_STUB', '1');
    signInAs({ kind: 'super_admin' });
    const before = snapshot(db);
    const result = await testAIConnectionAction();
    expect(result).toEqual(expect.objectContaining({ ok: true, model: expect.any(String), reply: expect.any(String) }));
    expect(snapshot(db)).toEqual(before);
  });

  it(`${TEST} a super admin with no key stored is told so, without a provider call`, async () => {
    vi.stubEnv('AI_PROVIDER_STUB', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    db.replace('app_settings', []);
    signInAs({ kind: 'super_admin' });
    expect(await testAIConnectionAction()).toEqual(expect.objectContaining({ ok: false, code: 'unconfigured' }));
  });

  it.each(REFUSED_CALLERS)(`${TEST} $label is refused before the settings are read`, async ({ caller }) => {
    vi.stubEnv('AI_PROVIDER_STUB', '1');
    signInAs(caller);
    const read = vi.spyOn(db, 'from');
    const before = snapshot(db);
    expect(await testAIConnectionAction()).toEqual({ ok: false, code: 'forbidden', message: 'actions.forbidden', detail: '' });
    expect(read).not.toHaveBeenCalled();
    expect(snapshot(db)).toEqual(before);
  });
});
