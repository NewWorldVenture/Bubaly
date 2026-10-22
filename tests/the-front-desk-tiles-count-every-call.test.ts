// The Front Desk's Calls, Filed and Urgent tiles are totals (U2).
//
// The page read the latest 100 voice rows and the module counted THAT array
// into three tiles labelled as totals: past 100 calls the tiles under-reported,
// and an urgent call older than the hundredth was simply absent from "Urgent".
// The tiles now read exact counts beside the list, and a count the database
// did not give is an em dash, as the failed-list case already was.
//
// Driven through the real page and the real module against an in-memory
// database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const io = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({ user: { id: 'user-1' }, active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => io.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'fam-1', userId: 'user-1', members: [], selfMember: null }) }));
// The frozen call log is its own section with its own tests; it reads nothing here.
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: [], loading: false, error: null, refresh: async () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement('a', { ...props, href }, children) }));

const FrontDeskPage = (await import('@/app/(app)/dashboard/front-desk/page')).default;
const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

const voice = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `call-${i}`, family_id: 'fam-1', channel: 'voice', direction: 'inbound', from_addr: `+1555000${String(i).padStart(4, '0')}`, to_addr: null,
  subject: null, body: null, ai_summary: `Call ${i}`, ai_intent: 'personal', ai_handled: i % 2 === 0, status: 'new', provider_ref: null,
  // Newest first by index: call-0 is the latest.
  occurred_at: new Date(Date.parse('2026-10-14T12:00:00Z') - i * 60_000).toISOString(), created_at: '2026-10-14T12:00:00Z', ...extra,
});
/** The three stat tiles' values, in STATS order: Calls, Filed, Urgent. */
function tiles(html: string): string[] {
  return [...html.matchAll(/text-2xl font-bold[^"]*">([^<]*)<\/div>/g)].map((m) => m[1]);
}
const page = async () => renderTranslated(await FrontDeskPage());

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  io.db = db;
  // 120 calls: 60 filed, and the 10 urgent ones are the OLDEST, past the list's 100.
  db.seed('family_inbox_messages', Array.from({ length: 120 }, (_, i) => voice(i, i >= 110 ? { ai_intent: 'urgent' } : {})));
  db.seed('family_contact_channels', [{ family_id: 'fam-1', phone_number: '+15550001111', email_local: 'rivera', provisioning_status: 'active', ai_concierge_enabled: true, forward_to_phone: null }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the Front Desk tiles', () => {
  it('count every voice row, not the latest 100', async () => {
    const html = await page();
    expect(tiles(html)).toEqual(['120', '60', '10']);
    // The card header carries the same total.
    expect(html).toMatch(/text-\[11px\] text-muted">120</);
    expect(html).not.toContain(t('frontDesk.theseCountsCouldNotBe'));
  });

  it('show an em dash, and say so, when a count could not be read — while the list still renders', async () => {
    io.db = withFaults(db, (table, calls) => (table === 'family_inbox_messages'
      && calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head)
      ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const html = await page();
    expect(tiles(html)).toEqual(['—', '—', '—']);
    expect(html).toContain(t('frontDesk.theseCountsCouldNotBe'));
    expect(html).toContain('Call 0');
    expect(html).not.toContain(t('frontDesk.theVoiceInboxCouldNotBe'));
  });

  it('a failed list read blanks the tiles too', async () => {
    io.db = withFaults(db, (table) => (table === 'family_inbox_messages' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const html = await page();
    expect(tiles(html)).toEqual(['—', '—', '—']);
    expect(html).toContain(t('frontDesk.theVoiceInboxCouldNotBe'));
  });
});
