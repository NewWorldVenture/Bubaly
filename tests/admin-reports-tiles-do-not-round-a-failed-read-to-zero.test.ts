import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SOURCE_MESSAGES } from '@/lib/i18n/messages';

// S-15's counterexample, reproduced by rendering rather than by grepping.
//
// The six platform tiles on /admin/reports read `(familyCount ?? 0)`, and `??`
// cannot tell "no families" from "the families table did not answer" — it picks
// the more flattering of the two and prints it in the same bold type as a real
// number. The page's own comment already promised tiles that "say unavailable
// rather than showing a zero this page cannot stand behind"; that was true of
// StrategyMetricTiles below them and false of these six.
//
// The banner naming the failed reads was already there, which is exactly why
// this mattered: the operator saw "some reads failed" above six confident
// zeroes, and a zero next to a warning still reads as a measurement.
//
// Each tile is driven independently, because they do not share a read: the
// three counts are `head: true` counts, while revenue is summed over the
// `subscriptions` ROWS and storage over the `documents` ROWS. A tile that took
// its availability from the wrong one of those would pass a both-fail test and
// still lie whenever only one side broke, so every case below fails ONE table
// and asserts the other five tiles still show their numbers.

let failing: string[] = [];
/**
 * Tables whose ROW read fails while their head-count SUCCEEDS.
 *
 * This is the case that tells correct wiring from wrong wiring, and it is not
 * hypothetical — the page's own comment describes it. The counts are exact and
 * uncapped; the row reads go through readAllAsQuery, which returns an error
 * when it reaches ROW_CEILING because the rows it has are only a prefix. So on
 * a big enough platform the subscriptions COUNT is trustworthy in the same
 * render where the subscriptions ROWS are not.
 *
 * Without this, a revenue tile wired to `activeSubCountResult` instead of
 * `subscriptionsResult` would pass every other case here, since both reads hit
 * the same table and a whole-table failure takes them down together.
 */
let failingRowsOnly: string[] = [];

function builder(table: string): Record<string, unknown> {
  // Whether this read was issued as `{ count: 'exact', head: true }`. The two
  // kinds of read on one table have to settle differently for the case above.
  let isHeadCount = false;
  const settle = () => {
    const rowsOnly = failingRowsOnly.includes(table);
    if (failing.includes(table) || (rowsOnly && !isHeadCount)) {
      return Promise.resolve({
        data: null,
        count: null,
        error: { message: rowsOnly ? `reached the row ceiling reading ${table}` : `relation "public.${table}" does not exist` },
      });
    }
    return Promise.resolve({ data: [], count: 7, error: null });
  };
  const chain: Record<string, unknown> = {
    then: (...a: unknown[]) => (settle() as Promise<unknown>).then(...(a as [])),
    catch: (...a: unknown[]) => (settle() as Promise<unknown>).catch(...(a as [])),
    finally: (...a: unknown[]) => (settle() as Promise<unknown>).finally(...(a as [])),
  };
  chain.select = (_columns?: unknown, options?: { head?: boolean }) => {
    if (options?.head) isHeadCount = true;
    return chain;
  };
  for (const m of ['eq', 'gte', 'lte', 'in', 'order', 'limit', 'not', 'is', 'neq', 'or', 'range', 'single', 'maybeSingle']) {
    chain[m] = () => chain;
  }
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (table: string) => builder(table) }),
  describeConfiguredServiceKey: () => null,
}));

vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => SOURCE_MESSAGES[key] ?? key,
}));

// The strategy tiles have their own coverage (strategy-metric-tiles.test.ts).
// They are stubbed here for two reasons: their "Unavailable" copy is the same
// string these six now use, so leaving them in would let a strategy tile
// satisfy an assertion meant for a platform tile; and StrategyMetricTiles is an
// async server component, which renderToStaticMarkup cannot render at all.
vi.mock('@/lib/metric/strategy-server', () => ({
  loadStrategyMetrics: async () => ({
    rework: null, compression: null, compressionRead: 'failed' as const, conversion: null, referrals: null,
  }),
}));
vi.mock('@/components/admin/strategy-metric-tiles', () => ({
  StrategyMetricTiles: () => null,
}));

const UNAVAILABLE = SOURCE_MESSAGES['strategyMetrics.unavailable'];

async function render(): Promise<string> {
  const { default: AdminReportsPage } = await import('@/app/(app)/admin/reports/page');
  return renderToStaticMarkup(await AdminReportsPage());
}

/** The markup of one tile: its label plus the value rendered above it. */
function tile(html: string, label: string): string {
  const at = html.indexOf(label);
  expect(at, `tile "${label}" is not on the page at all`).toBeGreaterThan(-1);
  return html.slice(Math.max(0, at - 400), at + label.length);
}

const TILES = {
  families: SOURCE_MESSAGES['adminReports.totalFamilies'],
  users: SOURCE_MESSAGES['adminReports.totalUsers'],
  subscriptions: SOURCE_MESSAGES['adminReports.activeSubscriptions'],
  revenue: SOURCE_MESSAGES['adminReports.monthlyRevenue'],
  documents: SOURCE_MESSAGES['adminReports.documents'],
  storage: SOURCE_MESSAGES['adminReports.storageUsed'],
} as const;

describe('/admin/reports tiles never round a failed read to zero', () => {
  beforeEach(() => { failing = []; failingRowsOnly = []; });

  it('shows real numbers when every read succeeds', async () => {
    const html = await render();
    for (const label of Object.values(TILES)) {
      expect(tile(html, label), `${label} should not say unavailable`).not.toContain(UNAVAILABLE);
    }
    // The control that makes the cases below mean something: with nothing
    // failing, the count tiles really do print the number they were given.
    expect(tile(html, TILES.families)).toContain('7');
  });

  // table -> the ONE tile it should take down.
  const CASES: Array<[string, keyof typeof TILES]> = [
    ['families', 'families'],
    ['profiles', 'users'],
    ['documents', 'documents'],
    ['subscriptions', 'subscriptions'],
  ];

  for (const [table, key] of CASES) {
    it(`says unavailable — not 0 — when ${table} does not answer`, async () => {
      failing = [table];
      const html = await render();
      expect(tile(html, TILES[key])).toContain(UNAVAILABLE);
      // The failure is still NAMED, so the tile is not the only signal.
      expect(html).toContain(`relation &quot;public.${table}&quot; does not exist`);
    });
  }

  it('a failed subscriptions read takes revenue with it, not just the count', async () => {
    failing = ['subscriptions'];
    const html = await render();
    // $0.00 summed over rows that were never read is the same lie as a 0 count.
    expect(tile(html, TILES.revenue)).toContain(UNAVAILABLE);
    expect(tile(html, TILES.revenue)).not.toContain('$0.00');
  });

  it('a failed documents read takes storage with it', async () => {
    failing = ['documents'];
    const html = await render();
    expect(tile(html, TILES.storage)).toContain(UNAVAILABLE);
    expect(tile(html, TILES.storage)).not.toContain('0 B');
  });

  it('one broken table costs ONE tile — the other five still report', async () => {
    failing = ['families'];
    const html = await render();
    expect(tile(html, TILES.families)).toContain(UNAVAILABLE);
    for (const key of ['users', 'subscriptions', 'revenue', 'documents', 'storage'] as const) {
      expect(tile(html, TILES[key]), `${TILES[key]} should still report`).not.toContain(UNAVAILABLE);
    }
  });

  // The wiring cases. Each fails ONE table's rows while its count still
  // answers, so a tile wired to the wrong half of the pair is caught here and
  // nowhere else.
  it('a subscriptions ROW failure costs revenue but NOT the active-subscription count', async () => {
    failingRowsOnly = ['subscriptions'];
    const html = await render();
    expect(tile(html, TILES.revenue)).toContain(UNAVAILABLE);
    expect(tile(html, TILES.revenue)).not.toContain('$0.00');
    // The count read succeeded and is exact, so this tile must still report it.
    expect(tile(html, TILES.subscriptions)).not.toContain(UNAVAILABLE);
    expect(tile(html, TILES.subscriptions)).toContain('7');
  });

  it('a documents ROW failure costs storage but NOT the document count', async () => {
    failingRowsOnly = ['documents'];
    const html = await render();
    expect(tile(html, TILES.storage)).toContain(UNAVAILABLE);
    expect(tile(html, TILES.storage)).not.toContain('0 B');
    expect(tile(html, TILES.documents)).not.toContain(UNAVAILABLE);
    expect(tile(html, TILES.documents)).toContain('7');
  });

  it('renders rather than throwing when every read fails', async () => {
    failing = ['families', 'profiles', 'subscriptions', 'documents', 'audit_logs'];
    const html = await render();
    // The heading is HTML-escaped on the way out ('Reports &amp; Analytics'),
    // so compare against the escaped form rather than the catalogue string.
    expect(html).toContain(SOURCE_MESSAGES['adminReports.reportsAmpAnalytics'].replace('&', '&amp;'));
    for (const label of Object.values(TILES)) {
      expect(tile(html, label)).toContain(UNAVAILABLE);
    }
  });
});
