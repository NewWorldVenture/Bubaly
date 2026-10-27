// The line under the network switch, the moment a family has left.
//
// N8-leave-copy-overpromises/private-status-after-leave (round 5). Round 4
// made the leave's toast say what leaving keeps: this month's published
// summaries hold the family's share until next month's. The status line drawn
// under the switch whenever the family is not contributing
// (intelligence.privateStatus) still said "you're not sharing or receiving
// anything", so right after a leave the screen promised, beneath that toast,
// the absolute "nothing is shared" the toast had stopped saying. It now says
// what is true from the moment of leaving: the household's data is not being
// used, and it receives no network insights.
//
// The real IntelligenceModule and its real server action on the in-memory
// database, read in each of the seven full catalogues.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
/** The catalogue the screen and the action read. */
const lang = vi.hoisted(() => ({ code: 'en-US' }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => {
  const harness = (await import('./helpers/module-harness')).localeProviderModule(h);
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { ...harness, useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(lang.code as never), key, params) };
});
vi.mock('@/components/app/page-header', async () => ({ PageHeader: (await import('./helpers/module-harness')).ui.PageHeader }));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages(lang.code as never), key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId, email: null },
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return { createServer: async () => clientFor(h), createServiceClient: () => h.db };
});

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');
const { getMessages } = await import('@/lib/i18n/messages');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';

/** What each catalogue's status line said after a leave, and what it says now. */
const STATUS = {
  'en-US': {
    was: 'Currently private — you’re not sharing or receiving anything.',
    now: 'Currently private — your household’s data isn’t being used, and you don’t receive network insights.',
  },
  'de-DE': {
    was: 'Derzeit privat – Sie teilen nichts und erhalten nichts.',
    now: 'Derzeit privat – die Daten Ihres Haushalts werden nicht verwendet, und Sie erhalten keine Netzwerk-Erkenntnisse.',
  },
  'es-ES': {
    was: 'Actualmente privado: no compartes ni recibes nada.',
    now: 'Actualmente privado: los datos de tu hogar no se están usando y no recibes conclusiones de la red.',
  },
  'fr-FR': {
    was: 'Actuellement privé — vous ne partagez ni ne recevez rien.',
    now: 'Actuellement privé — les données de votre foyer ne sont pas utilisées et vous ne recevez pas les enseignements du réseau.',
  },
  'it-IT': {
    was: 'Attualmente privato: non condividi né ricevi nulla.',
    now: 'Attualmente privato: i dati del tuo nucleo familiare non vengono usati e non ricevi le informazioni della rete.',
  },
  'nl-NL': {
    was: 'Momenteel privé — je deelt en ontvangt niets.',
    now: 'Momenteel privé — de gegevens van je huishouden worden niet gebruikt en je ontvangt geen netwerkinzichten.',
  },
  'pt-PT': {
    was: 'Atualmente privado — não partilha nem recebe nada.',
    now: 'Atualmente privado — os dados do seu agregado familiar não estão a ser usados e não recebe as conclusões da rede.',
  },
} as const;

let db: InMemorySupabase;
const screen = () => render(h.hooks, createElement(IntelligenceModule, {}));
/** The line under the master switch's heading. */
const statusLine = (tree: ReturnType<typeof screen>, heading: string) => {
  const block = nodes(tree).find((n) => n.type === 'div' && nodes(n).some((c) => c.type === 'h3' && text(c) === heading)
    && nodes(n).some((c) => c.props.role === 'switch'));
  const line = block && nodes(block).find((n) => n.type === 'p');
  expect(line, `no status line under ${heading}`).toBeDefined();
  return text(line);
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ uniques: { network_contributions: [['family_id']], app_settings: [['key']] } });
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.fault = null;
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-1', role: 'parent' });
  db.seed('network_consent', [{
    id: 'consent-1', family_id: FAMILY, enabled: true,
    scopes: { timing: false, benchmarks: true, recommendations: false },
    consented_by: 'user-1', consented_at: '2026-10-01T00:00:00.000Z',
  }]);
  db.seed('network_contributions', [
    { family_id: FAMILY, cohort_key: 'kids:6–9|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } },
  ]);
});
afterEach(() => { lang.code = 'en-US'; vi.restoreAllMocks(); });

describe('right after a leave, the status line says what leaving does, not that nothing is shared', () => {
  it.each(Object.entries(STATUS))('%s', async (code, { was, now }) => {
    lang.code = code;
    const messages = getMessages(code as never);
    await click(byName(screen(), messages['intelligence.joinTheNetwork']));
    // The leave happened, and its toast says the published summaries keep the share …
    expect(db.table('network_consent')[0]).toMatchObject({ enabled: false });
    expect(h.toasts.success).toEqual([messages['intelligence.leftTheNetwork'].replace('{floor}', '20')]);
    // … and the line under the switch no longer says the opposite.
    const line = statusLine(screen(), messages['intelligence.joinTheIntelligenceNetwork']);
    expect(line).toBe(now);
    expect(line).not.toBe(was);
  });

  it('in English it promises nothing about sharing at all', async () => {
    await click(byName(screen(), 'Join the network'));
    const line = statusLine(screen(), 'Join the Intelligence Network');
    expect(line).not.toMatch(/not sharing|nothing|anything/i);
  });
});
