// Admin reach N14 (with its duplicate N15) — saving /admin/ai erased the
// per-task model map.
//
// lib/ai/routing.ts reads app_settings.ai_provider.models[task] for the
// planner, structured calls and paperwork vision. setAIConfig rebuilt that
// value from the four fields the form edits and upserted it whole, so any
// ordinary save — rotating the OpenAI key, changing the chat model — dropped
// `models` and quietly sent every family's planning, vision and classification
// back to the defaults. The audit row said nothing about it.
//
// Driven through the REAL admin action and the REAL routing reader against the
// in-memory database. Negative control: before the fix the planner resolved
// to the default model after a key rotation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/auth/super-admin-gate', () => ({ superAdminGate: async () => ({ status: 'allowed', user: { id: 'admin-1' } }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { saveAIConfigAction } = await import('@/app/(app)/admin/ai/actions');
const { resolveModelForTaskFromSettings, taskEnvVar } = await import('@/lib/ai/routing');

let db: InMemorySupabase;
const stored = () => db.table('app_settings').find((row) => row.key === 'ai_provider')?.value as Record<string, unknown>;
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  db.seed('app_settings', [{ key: 'ai_provider', updated_by: null, value: {
    provider: 'openai', model: 'gpt-4o-mini', openaiKey: 'sk-old', anthropicKey: null,
    models: { plan: 'o3', vision: 'gpt-4.1' },
  } }]);
  for (const task of ['plan', 'vision'] as const) vi.stubEnv(taskEnvVar(task), '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('an /admin/ai save', () => {
  it('rotating the key keeps the per-task model map the router reads', async () => {
    expect(await resolveModelForTaskFromSettings('plan')).toMatchObject({ model: 'o3', source: 'settings' });
    expect(await saveAIConfigAction(form({ model: 'gpt-4o-mini', openaiKey: 'sk-new' }))).toEqual({ ok: true });
    expect(stored()).toMatchObject({ openaiKey: 'sk-new', models: { plan: 'o3', vision: 'gpt-4.1' } });
    expect(await resolveModelForTaskFromSettings('plan')).toMatchObject({ model: 'o3', source: 'settings' });
    expect(await resolveModelForTaskFromSettings('vision')).toMatchObject({ model: 'gpt-4.1', source: 'settings' });
  });

  it('the control: the fields the form edits still change, and a blank key keeps the stored one', async () => {
    await saveAIConfigAction(form({ model: 'gpt-4.1', openaiKey: '' }));
    expect(stored()).toMatchObject({ provider: 'openai', model: 'gpt-4.1', openaiKey: 'sk-old' });
  });
});
