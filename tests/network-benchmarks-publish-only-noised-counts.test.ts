// /resources/benchmarks, the content export and the digest's comparison — what
// they publish.
//
// N1 / N3 / N4 / N6 / N16 — the public page printed, beside "About {count}
// families report …" (noised), "cohort of {n} families" with n = the TRUE
// number of families behind that band. The noise cancelled: two nights' pages
// differed by exactly who joined, left or changed band, which is the
// differencing the page's own methodology line promises cannot happen. The
// label was wrong too — it is a band's count, not the cohort's size. The CSV
// handed to content carried the same number as `cohort_n`. And the rows were
// ORDERED by the true size, so even unprinted it showed which of two close
// bands was really the larger.
//
// N8 — every reader showed whatever the last successful run wrote, for as long
// as later runs kept failing, with withdrawn families still inside it. Past
// 36 hours a reader shows its empty state instead.
//
// The real page, route and loader against the in-memory database.
import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
/** The request's locale: en-US unless a case reads the page in another one. */
const request = vi.hoisted(() => ({ locale: 'en-US' }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.db, createServer: async () => holder.db }));
// Both halves of lib/i18n/server the page reaches: its translator, and the
// locale its formatter (lib/utils/format-server, getFormat) is bound to.
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate: tr } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(getMessages(request.locale as never), key, params),
    getLocaleContext: async () => ({ locale: { code: request.locale }, source: 'default', messages: getMessages(request.locale as never) }),
  };
});
vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => ({ id: 'admin-1', email: 'admin@example.test' }), isSuperAdmin: async () => true }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }), SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin' }));
vi.mock('@/lib/server/audit', () => ({ recordAudit: async () => ({ ok: true }) }));

const { default: BenchmarksPage } = await import('@/app/(marketing)/resources/benchmarks/page');
const { default: AdminBenchmarksPage } = await import('@/app/(app)/admin/benchmarks/page');
const { GET: exportCsv } = await import('@/app/api/admin/benchmarks/export/route');
const { loadCompareLine } = await import('@/lib/network/compare-line-server');

/** Every string the tree carries as children, without rendering a component. */
function strings(node: ReactNode, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) strings(child, out); return out; }
  if (!isValidElement<{ children?: ReactNode }>(node)) return out;
  strings(node.props.children, out);
  return out;
}

const COHORT = 'kids:6–9|size:3–4';
let db: InMemorySupabase;
let seq = 0;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const aggregate = (metric: string, value: string, count: number, cohortSize: number, computedAt = hoursAgo(9), cohortKey = COHORT) => ({
  id: `agg-${String(++seq).padStart(4, '0')}`, scope: 'benchmarks', cohort_key: cohortKey, metric, value, count, cohort_size: cohortSize, computed_at: computedAt,
});

beforeEach(() => {
  request.locale = 'en-US';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  db = createInMemorySupabase({ maxRows: 1000 });
  holder.db = db;
  seq = 0;
  db.seed('marketing_settings', [{ key: 'benchmarks_public', value: { enabled: true }, updated_at: hoursAgo(100) }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('/resources/benchmarks publishes the noised count, and only that', () => {
  it('never prints the true number of families behind a band', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47)]);
    const text = strings(await BenchmarksPage()).join(' ');
    expect(text).toContain('About 44 families report');
    expect(text).not.toContain('47');
    expect(text).not.toMatch(/cohort of \d+ families/);
  });

  it('orders a metric\'s rows by the noised count, so the order says nothing the numbers do not', async () => {
    db.seed('network_aggregates', [
      aggregate('dinner_habit', 'often (4–5)', 44, 47),       // truly the larger
      aggregate('dinner_habit', 'sometimes (2–3)', 52, 46),   // larger as shown
    ]);
    const rows = strings(await BenchmarksPage()).filter((s) => s.startsWith('About '));
    expect(rows).toEqual(['About 52 families report “sometimes (2–3)”', 'About 44 families report “often (4–5)”']);
  });

  it('shows its empty state, not the last run\'s figures, once those are older than a day and a half', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47, hoursAgo(72))]);
    const text = strings(await BenchmarksPage()).join(' ');
    expect(text).toContain('No benchmarks published yet');
    expect(text).not.toContain('About 44 families');
  });
});

// N8-leave-copy-overpromises: the methodology said "comparing two weeks can
// never reveal that one family joined or left". The figures change once a
// month (aggregate.ts, PUBLICATION_EPOCH), and the sticky noise bounds what a
// month-to-month comparison gives away; it does not make it impossible
// (aggregate-server.ts, stickyNoise, measured in
// tests/network-noise-is-drawn-once-per-epoch.test.ts).
describe('the methodology says how often the figures change, and that the noise makes a join or leave unlikely to read, not impossible', () => {
  it('says monthly and "unlikely, but not impossible", never "two weeks" or "can never reveal"', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47)]);
    const text = strings(await BenchmarksPage()).join(' ');
    expect(text).toContain('Figures are published once a month with calibrated noise, so comparing one month with the next makes it unlikely, but not impossible, to tell that one family joined or left.');
    expect(text).not.toMatch(/can never reveal|two weeks/);
  });
});

// N8-leave-copy-overpromises/last-updated-vs-monthly (round 5). The header
// printed "Last updated {date}" from `computedAt`, which every night of the
// epoch re-stamps without changing a figure (benchmarks-server.ts), so it read
// "yesterday" beside "Figures are published once a month". It names the month
// the figures were published in now: the epoch, a UTC calendar month.
describe('the page dates its figures by the month they were published, not the nightly re-stamp', () => {
  /** What each full catalogue's "Last updated" line began with. */
  const LAST_UPDATED = {
    'en-US': 'Last updated', 'de-DE': 'Zuletzt aktualisiert', 'es-ES': 'Última actualización', 'fr-FR': 'Dernière mise à jour',
    'it-IT': 'Ultimo aggiornamento', 'nl-NL': 'Laatst bijgewerkt', 'pt-PT': 'Última atualização',
  } as const;
  const PUBLISHED = {
    'en-US': 'Published November 2026', 'de-DE': 'Veröffentlicht im November 2026', 'es-ES': 'Publicado en noviembre de 2026',
    'fr-FR': 'Publié en novembre 2026', 'it-IT': 'Pubblicato a novembre 2026', 'nl-NL': 'Gepubliceerd in november 2026',
    'pt-PT': 'Publicado em novembro de 2026',
  } as const;
  afterEach(() => { vi.useRealTimers(); });

  it('three weeks into the month, re-stamped last night, it says the month it was published in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47, '2026-11-24T03:00:00.000Z')]);
    const text = strings(await BenchmarksPage()).join(' ');
    expect(text).toContain('Published November 2026');
    expect(text).not.toContain('Last updated');
    expect(text).not.toMatch(/Nov 24/);
  });

  it('names the UTC month on its first night whatever zone the server runs in, in every full catalogue', async () => {
    // 03:00Z on the 1st is still October in Los Angeles: the epoch is not.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47, '2026-11-01T03:00:00.000Z')]);
    for (const [locale, published] of Object.entries(PUBLISHED)) {
      request.locale = locale;
      const text = strings(await BenchmarksPage()).join(' ');
      expect(text, locale).toContain(published);
      expect(text, locale).not.toContain(LAST_UPDATED[locale as keyof typeof LAST_UPDATED]);
    }
  });
});

describe('the admin report shows what the export holds, and no true size (N6, admin table)', () => {
  // The CSV dropped cohort_n because it is quoted; the same super-admin could
  // quote it from this table instead, under a hint saying the file holds "the
  // rows below".
  it('lists each band\'s noised count and never the true number behind it', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47), aggregate('bedtime_band', '8–9pm', 63, 61)]);
    const text = strings(await AdminBenchmarksPage());
    expect(text).toContain('44');
    expect(text).toContain('63');
    expect(text).not.toContain('47');
    expect(text).not.toContain('61');
    expect(text).not.toContain('n (distinct families)');
    expect(text).toContain('Families (noised)');
    // The hint is true of the page again: the rows below, same noised counts.
    expect(text).toContain('Downloads the rows below as CSV for content and research. Same floor, same noised counts — no per-family data exists to export.');
  });
});

describe('the content export carries no true size either', () => {
  it('has no cohort_n column and no true band size in any row', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47), aggregate('bedtime_band', '8–9pm', 63, 61)]);
    const response = await exportCsv();
    expect(response.status).toBe(200);
    const [header, ...lines] = (await response.text()).trimEnd().split('\r\n');
    expect(header.split(',')).not.toContain('cohort_n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const cells = line.split(',');
      expect(cells).not.toContain('47');
      expect(cells).not.toContain('61');
    }
    expect(lines.join('\n')).toContain(',44,');
  });

  it('exports nothing a failing cron left behind', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47, hoursAgo(72))]);
    const lines = (await (await exportCsv()).text()).trimEnd().split('\r\n');
    expect(lines).toHaveLength(1); // the header alone
  });
});

describe('the weekly digest\'s comparison is drawn from fresh aggregates only', () => {
  const FAMILY = 'fam-1';
  beforeEach(() => {
    db.seed('network_consent', [{ family_id: FAMILY, enabled: true, scopes: { benchmarks: true } }]);
    db.seed('network_contributions', [{ family_id: FAMILY, cohort_key: COHORT, metrics: { dinner_habit: 'often (4–5)' } }]);
  });

  it('compares against the current aggregates', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47)]);
    expect(await loadCompareLine(db as never, FAMILY)).toMatchObject({ metric: 'dinner_habit', count: 44, matches: true });
  });

  it('says nothing from aggregates a run that kept failing left behind', async () => {
    db.seed('network_aggregates', [aggregate('dinner_habit', 'often (4–5)', 44, 47, hoursAgo(72))]);
    expect(await loadCompareLine(db as never, FAMILY)).toBeNull();
  });
});
