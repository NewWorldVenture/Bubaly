import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue, textOf } from './helpers/render-server-page';

// /admin/audit tallied its four tiles — Logged events, Site admin actions,
// Action types, Families touched — from the newest 1,000 events it lists, and
// /admin/audit-logs said "of N logs" over the newest 500, so past them each
// was the listed window presented as the whole audit log (coverage sweep
// round 9, class B). The counts are head:true counts now, the distinct tallies
// page every event on the id to a ceiling past which they say they are not
// shown, and each list says when it holds only part of the log. The REAL
// pages, in-memory database with PostgREST's 1,000-row cap.
const CAP = 1000;
const TALLY_CEILING = 25_000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));

let db: InMemorySupabase;
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const event = (k: number, action: string, family: string | null, viaAdmin: boolean): Row => ({
  id: `log-${pad(k)}`, family_id: family, actor_id: null, action, resource: 'chore', resource_id: null,
  metadata: viaAdmin ? { via: 'site_admin' } : {},
  // Higher k is newer.
  created_at: new Date(Date.UTC(2026, 0, 1) + k * 60_000).toISOString(),
});

/**
 * 1,200 events. The 200 OLDEST are 'export' events by the site admin in
 * families no newer event touches, so the newest thousand hold none of them.
 */
function seedPastTheList() {
  db.seed('audit_logs', [
    ...Array.from({ length: 200 }, (_, k) => event(k, 'export', `fam-old-${k % 20}`, true)),
    ...Array.from({ length: 1000 }, (_, k) => event(200 + k, k % 2 ? 'update' : 'create', `fam-new-${k % 5}`, false)),
  ]);
  db.seed('families', []);
  db.seed('profiles', []);
}

async function renderAudit(): Promise<string> {
  const { default: AdminAuditPage } = await import('@/app/(app)/admin/audit/page');
  return renderServerPage(await AdminAuditPage({ searchParams: Promise.resolve({}) }));
}
async function renderAuditLogs(): Promise<string> {
  const { default: AuditLogsPage } = await import('@/app/(app)/admin/audit-logs/page');
  return renderServerPage(await AuditLogsPage({ searchParams: Promise.resolve({}) }));
}
const note = (shown: number, total: number) => m('adminCeiling.listAndFiltersShowTheNewest', { shown: shown.toLocaleString(), total: total.toLocaleString() });
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/audit past the 1,000 events it lists', () => {
  it('every tile covers the whole log, and the list says it holds the newest thousand', async () => {
    seedPastTheList();
    const html = await renderAudit();
    expect(html).not.toContain(SOURCE_MESSAGES['audit.couldNotLoadAuditLogs']);
    expect(statCardValue(html, m('adminAudit.loggedEvents'))).toBe('1,200');
    expect(statCardValue(html, m('adminAudit.siteAdminActions'))).toBe('200');
    expect(statCardValue(html, m('adminAudit.actionTypes'))).toBe('3');
    expect(statCardValue(html, m('adminAudit.familiesTouched'))).toBe('25');
    expect(textOf(html)).toContain(note(1000, 1200));
  });

  it('past the tally ceiling the two distinct tallies say they are not shown; the counts stay exact', async () => {
    db.seed('audit_logs', Array.from({ length: TALLY_CEILING + 1 }, (_, k) => event(k, 'update', `fam-${k % 3}`, k < 7)));
    db.seed('families', []);
    db.seed('profiles', []);
    const html = await renderAudit();
    expect(html).not.toContain(SOURCE_MESSAGES['audit.couldNotLoadAuditLogs']);
    expect(statCardValue(html, m('adminAudit.loggedEvents'))).toBe((TALLY_CEILING + 1).toLocaleString());
    expect(statCardValue(html, m('adminAudit.siteAdminActions'))).toBe('7');
    expect(statCardValue(html, m('adminAudit.actionTypes'))).toBe(unavailable);
    expect(statCardValue(html, m('adminAudit.familiesTouched'))).toBe(unavailable);
    const banner = textOf(html.slice(html.indexOf(m('adminCeiling.figuresNotShown', { n: TALLY_CEILING.toLocaleString() }))));
    expect(banner).toContain(`${m('adminAudit.actionTypes')} ${m('adminAudit.familiesTouched')}`);
  });

  it.each([
    ['the event count', (calls: FaultCall[]) => head(calls) && !calls.some((c) => c.method === 'eq')],
    ['the site-admin count', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'metadata->>via')],
    ['the distinct tally, on its first page', (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && c.args[0] === 'id, action, family_id') && !calls.some((c) => c.method === 'gt')],
  ])('a read that FAILS (%s) is the read-error state, not a tile of the list', async (_, failing) => {
    seedPastTheList();
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'audit_logs' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'audit_logs unavailable' };
    });
    const html = await renderAudit();
    expect(faulted).toBe(1);
    expect(html).toContain(SOURCE_MESSAGES['audit.couldNotLoadAuditLogs']);
    expect(html).not.toContain(m('adminAudit.loggedEvents'));
  });

  it('the control: a log that fits the list is counted the same, and says nothing about part of it', async () => {
    db.seed('audit_logs', [event(1, 'update', 'fam-1', true), event(2, 'create', 'fam-2', false), event(3, 'create', 'fam-2', false)]);
    db.seed('families', []);
    db.seed('profiles', []);
    const html = await renderAudit();
    expect(statCardValue(html, m('adminAudit.loggedEvents'))).toBe('3');
    expect(statCardValue(html, m('adminAudit.siteAdminActions'))).toBe('1');
    expect(statCardValue(html, m('adminAudit.actionTypes'))).toBe('2');
    expect(statCardValue(html, m('adminAudit.familiesTouched'))).toBe('2');
    expect(textOf(html)).not.toContain(note(3, 3).slice(0, 30));
  });
});

describe('/admin/audit-logs past the 500 logs it lists', () => {
  it('the list says it holds the newest 500 of every log', async () => {
    seedPastTheList();
    const html = await renderAuditLogs();
    expect(html).not.toContain(SOURCE_MESSAGES['auditLogs.couldNotLoadAuditLogs']);
    expect(textOf(html)).toContain(note(500, 1200));
  });

  it('a log count that FAILS is the read-error state', async () => {
    seedPastTheList();
    h.db = withFaults(db, (table, calls) => (table === 'audit_logs' && head(calls) ? { message: 'audit_logs unavailable' } : null));
    const html = await renderAuditLogs();
    expect(html).toContain(SOURCE_MESSAGES['auditLogs.couldNotLoadAuditLogs']);
  });

  it('the control: a log that fits the list says nothing about part of it', async () => {
    db.seed('audit_logs', [event(1, 'update', 'fam-1', false)]);
    const html = await renderAuditLogs();
    expect(html).not.toContain(SOURCE_MESSAGES['auditLogs.couldNotLoadAuditLogs']);
    expect(textOf(html)).not.toContain(note(1, 1).slice(0, 30));
    expect(textOf(html)).toContain('of 1 logs');
  });
});
