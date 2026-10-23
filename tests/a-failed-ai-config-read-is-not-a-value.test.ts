import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// getAIConfigView dropped its app_settings error, so a refused or unreachable
// read became `{}`: "no stored key, default model" (review
// R9-AI-CONFIG-VIEW-FAILED-READ-IS-A-VALUE). With gpt-4.1 and a key stored in
// the admin console and no OPENAI_API_KEY in the environment:
//  - /admin/ai preselected gpt-4o, dropped "OpenAI key is set", and its Save
//    wrote gpt-4o over the stored gpt-4.1 from a state nobody had read;
//  - /admin/settings read "OPENAI_API_KEY not set · Not set", the env fallback
//    (its `.catch(() => null)` could not see a RESOLVED error);
//  - /admin/marketing/settings read "Set OPENAI_API_KEY".
// Each now says the config could not be read. The REAL pages, in-memory
// database, the app_settings read failing (and counted, so a fault that never
// fires cannot pass) beside a control where it answers.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
// The form's server actions and the marketing settings action; none is called by a render.
vi.mock('@/app/(app)/admin/ai/actions', () => ({
  saveAIConfigAction: async () => ({ ok: true }),
  testAIConnectionAction: async () => ({ ok: false, code: 'unknown', message: '', detail: '' }),
}));
vi.mock('@/app/(app)/admin/marketing/actions', () => ({ saveSetting: async () => {} }));

const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
let db: InMemorySupabase;
let faulted = 0;

function seed(value: Record<string, unknown> = { provider: 'openai', model: 'gpt-4.1', openaiKey: 'sk-stored' }) {
  db.seed('app_settings', [{ key: 'ai_provider', value }]);
  db.seed('super_admins', [{ id: 'sa-1', email: 'root@example.com' }]);
  db.seed('marketing_settings', [{ id: 'ms-1', key: 'from_name', value: { text: 'Bubaly' } }]);
}

/** The app_settings read fails; every other table answers. */
function failAppSettings() {
  h.db = withFaults(db, (table) => {
    if (table !== 'app_settings') return null;
    faulted += 1;
    return { code: '42501', message: 'permission denied for table app_settings' };
  });
}

async function renderPage(path: 'ai' | 'settings' | 'marketing/settings'): Promise<string> {
  const page = path === 'ai' ? await import('@/app/(app)/admin/ai/page')
    : path === 'settings' ? await import('@/app/(app)/admin/settings/page')
      : await import('@/app/(app)/admin/marketing/settings/page');
  return renderServerPage(await page.default());
}

/** The words of the list row that names `name`. */
function row(html: string, name: string): string {
  const rows = html.match(/<li[^>]*>.*?<\/li>/g) ?? [];
  const found = rows.map(textOf).find((text) => text.startsWith(`${name} `));
  if (!found) throw new Error(`no "${name}" row on the page`);
  return found;
}

/** A System card line on /admin/settings: label, then value. */
function systemValue(html: string, label: string): string | undefined {
  return new RegExp(`<span class="text-muted">${label.replace(/[()]/g, '\\$&')}</span><span class="truncate font-medium">([^<]*)</span>`).exec(html)?.[1];
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  faulted = 0;
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.stubEnv('AI_MODEL', undefined);
  vi.stubEnv('STRIPE_SECRET_KEY', undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/admin/ai: a failed read is the error state, and no Save is offered', () => {
  it('says the settings could not be read and renders no form', async () => {
    seed();
    failAppSettings();
    const html = await renderPage('ai');
    expect(faulted).toBe(1);
    const text = textOf(html);
    expect(text).toContain(SOURCE_MESSAGES['adminAi.couldNotLoadAiEngineSettings']);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('name="model"');
    expect(text).not.toContain('Save AI engine');
    expect(text).not.toContain(SOURCE_MESSAGES['adminAiAiEngineForm.noOpenaiKeyConfiguredYet']);
    expect(text).not.toContain(SOURCE_MESSAGES['adminAi.currentlyActive']);
    expect(html).toContain('href="/admin/ai"');
    expect(console.error).toHaveBeenCalled();
  });

  it('the control: a read that answers preselects the stored model and says the key is set', async () => {
    seed();
    const html = await renderPage('ai');
    const text = textOf(html);
    expect(html).toContain('<option value="gpt-4.1" selected="">gpt-4.1</option>');
    expect(html).not.toContain('<option value="gpt-4o" selected="">');
    expect(text).toContain(SOURCE_MESSAGES['adminAiAiEngineForm.openaiKeyIsSet']);
    expect(text).toContain('Save AI engine');
    expect(text).toContain(`${SOURCE_MESSAGES['adminAi.currentlyActive']} ChatGPT (OpenAI) · gpt-4.1.`);
    expect(text).not.toContain(SOURCE_MESSAGES['adminAi.couldNotLoadAiEngineSettings']);
  });

  it('the control: nothing stored is the default model and no key, from a read that answered', async () => {
    db.seed('super_admins', [{ id: 'sa-1', email: 'root@example.com' }]);
    const html = await renderPage('ai');
    expect(html).toContain('<option value="gpt-4o" selected="">gpt-4o</option>');
    expect(textOf(html)).toContain(SOURCE_MESSAGES['adminAiAiEngineForm.noOpenaiKeyConfiguredYet']);
  });
});

describe('/admin/settings: a failed read is Unavailable, not the env signal', () => {
  it('reads the OpenAI row and the AI model as Unavailable', async () => {
    seed();
    failAppSettings();
    const html = await renderPage('settings');
    expect(faulted).toBe(1);
    expect(row(html, 'OpenAI (AI)')).toBe(`OpenAI (AI) — ${unavailable}`);
    expect(systemValue(html, 'AI model')).toBe(unavailable);
    expect(textOf(html)).not.toContain('OPENAI_API_KEY not set');
    // Only the AI config was not read: the rest of the page is its values.
    expect(row(html, 'Stripe (payments)')).toBe(`Stripe (payments) STRIPE_SECRET_KEY ${SOURCE_MESSAGES['settings.notSet']}`);
    expect(systemValue(html, 'Super administrators')).toBe('1');
  });

  it('does not call it Connected from an environment key either', async () => {
    seed();
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    vi.stubEnv('AI_MODEL', 'gpt-4o-mini');
    failAppSettings();
    const html = await renderPage('settings');
    expect(faulted).toBe(1);
    expect(row(html, 'OpenAI (AI)')).toBe(`OpenAI (AI) — ${unavailable}`);
    expect(systemValue(html, 'AI model')).toBe(unavailable);
  });

  it('the control: the stored model and key source, Connected', async () => {
    seed();
    const html = await renderPage('settings');
    expect(row(html, 'OpenAI (AI)')).toBe(`OpenAI (AI) gpt-4.1 · key from admin console ${SOURCE_MESSAGES['settings.connected']}`);
    expect(systemValue(html, 'AI model')).toBe('gpt-4.1');
    expect(html).not.toContain(unavailable);
  });

  it('the control: an environment key is named as the source', async () => {
    db.seed('super_admins', [{ id: 'sa-1', email: 'root@example.com' }]);
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    vi.stubEnv('AI_MODEL', 'gpt-4o-mini');
    const html = await renderPage('settings');
    expect(row(html, 'OpenAI (AI)')).toBe(`OpenAI (AI) gpt-4o-mini · key from env (OPENAI_API_KEY) ${SOURCE_MESSAGES['settings.connected']}`);
    expect(systemValue(html, 'AI model')).toBe('gpt-4o-mini');
  });

  it('the control: no key anywhere, from a read that answered, is Not set', async () => {
    db.seed('super_admins', [{ id: 'sa-1', email: 'root@example.com' }]);
    const html = await renderPage('settings');
    expect(row(html, 'OpenAI (AI)')).toBe(`OpenAI (AI) OPENAI_API_KEY not set ${SOURCE_MESSAGES['settings.notSet']}`);
    expect(systemValue(html, 'AI model')).toBe('default');
  });
});

describe('/admin/marketing/settings: a failed read is Unavailable, not "Set OPENAI_API_KEY"', () => {
  it('reads the AI provider row as Unavailable and keeps the rest of the page', async () => {
    seed();
    failAppSettings();
    const html = await renderPage('marketing/settings');
    expect(faulted).toBe(1);
    expect(row(html, 'AI (OpenAI)')).toBe(`AI (OpenAI) ${unavailable}`);
    expect(textOf(html)).not.toContain('Set OPENAI_API_KEY');
    expect(row(html, 'Payments (Stripe)')).toBe('Payments (Stripe) Set STRIPE_SECRET_KEY');
    // The marketing settings were read, so their forms stand.
    expect(html).toContain('value="Bubaly"');
    expect(textOf(html)).not.toContain(SOURCE_MESSAGES['settings.couldNotLoadMarketingSettings']);
  });

  it('does not call it Connected from an environment key either', async () => {
    seed();
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    failAppSettings();
    const html = await renderPage('marketing/settings');
    expect(faulted).toBe(1);
    expect(row(html, 'AI (OpenAI)')).toBe(`AI (OpenAI) ${unavailable}`);
  });

  it('the control: a key stored in the admin console is Connected', async () => {
    seed();
    const html = await renderPage('marketing/settings');
    expect(row(html, 'AI (OpenAI)')).toBe(`AI (OpenAI) ${SOURCE_MESSAGES['settings.connected']}`);
    expect(html).not.toContain(unavailable);
  });

  it('the control: no key anywhere, from a read that answered, asks for OPENAI_API_KEY', async () => {
    db.seed('marketing_settings', [{ id: 'ms-1', key: 'from_name', value: { text: 'Bubaly' } }]);
    const html = await renderPage('marketing/settings');
    expect(row(html, 'AI (OpenAI)')).toBe('AI (OpenAI) Set OPENAI_API_KEY');
  });
});
