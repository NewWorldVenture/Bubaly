// Jobs whose contract is EVERY row, measured against a server that caps.
//
// PostgREST answers a select with at most `db-max-rows` — 1,000 on a default
// Supabase project — and reports nothing: no error, no header the client
// surfaces, no short-read signal. A job that iterates households therefore
// cannot tell "that is the whole table" from "that is the first thousand",
// and the failures that follow are all silent:
//
//   - a morning brief that never reaches family 1,001, while the job counts
//     itself complete;
//   - a marketing push that treats an opt-out past the cap as an opt-in and
//     contacts the person anyway;
//   - an aggregation that DELETES the contribution of a family that is still
//     opted in, because it was absent from a truncated consent list.
//
// So these read through `readAll`, and this file pins that by giving the fake
// the server's cap and asserting the job still sees everyone. Each assertion
// fails against the unbounded `.select()` these call sites used before.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { deliverMorningBriefs } from '@/lib/briefing/deliver';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';
import { getMarketingCustomersWithError } from '@/lib/marketing/customers';
import { runAutomations } from '@/lib/marketing/automation-runner';

type DB = SupabaseClient<Database>;

/** The default project ceiling, and the number these jobs must read past. */
const CAP = 1000;
const OVER = CAP + 11;

function capped(): InMemorySupabase {
  return createInMemorySupabase({ maxRows: CAP });
}

function ids(prefix: string, n: number): string[] {
  // Zero-padded so lexical order matches numeric order — the paged reads order
  // by id, and a fake that sorts '10' before '9' would hide a paging bug.
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`);
}

describe('the fake enforces the cap it is given', () => {
  it('answers an unbounded select with at most maxRows, and no error', async () => {
    const db = capped();
    db.seed('families', ids('fam', OVER).map((id) => ({ id, timezone: 'UTC' })));

    const { data, error } = await (db as unknown as DB).from('families').select('id');

    // Exactly the shape the real server produces: short, and silent about it.
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('leaves reads alone when no cap is configured', async () => {
    const db = createInMemorySupabase();
    db.seed('families', ids('fam', OVER).map((id) => ({ id, timezone: 'UTC' })));

    const { data } = await (db as unknown as DB).from('families').select('id');
    expect(data).toHaveLength(OVER);
  });
});

describe('the morning brief cron', () => {
  it('visits every family, not the first page of them', async () => {
    const db = capped();
    db.seed('families', ids('fam', OVER).map((id) => ({ id, timezone: 'UTC' })));

    // Composing a real brief per family is not what is under test here; the
    // count of families the job actually walked is.
    const result = await deliverMorningBriefs(db as unknown as DB, new Date('2026-09-07T11:00:00Z'));

    expect(result.families).toBe(OVER);
  });
});

describe('network aggregation', () => {
  it('keeps the contribution of a consenting family past the cap', async () => {
    const db = capped();
    const families = ids('fam', OVER);
    db.seed('network_consent', families.map((id) => ({ family_id: id, enabled: true, scopes: {} })));
    // Every opted-in family already has a contribution row from an earlier run.
    db.seed('network_contributions', families.map((id) => ({
      family_id: id, cohort_key: 'k', features: {}, metrics: {}, scopes: {},
    })));

    await runNetworkAggregation(db as unknown as DB, new Date('2026-09-07T11:00:00Z'));

    // The prune deletes every family_id absent from the consent list. Read the
    // list short and a family that never withdrew consent is erased anyway.
    const survivors = db.table('network_contributions').map((r) => r.family_id);
    expect(survivors).toHaveLength(OVER);
    expect(survivors).toContain(families[OVER - 1]);
  });
});

describe('the marketing customer view', () => {
  it('reads subscriptions, members and profiles past the cap', async () => {
    const db = capped();
    const families = ids('fam', OVER);
    const users = ids('user', OVER);
    db.seed('families', families.map((id) => ({ id, name: id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })));
    db.seed('subscriptions', families.map((id) => ({
      family_id: id, plan: 'plus', status: 'active',
      created_at: '2026-01-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z',
    })));
    db.seed('family_members', families.map((id, i) => ({
      family_id: id, user_id: users[i], role: 'parent', is_active: true,
    })));
    db.seed('profiles', users.map((id) => ({ id, email: `${id}@example.com` })));

    const { customers, error } = await getMarketingCustomersWithError(db as unknown as DB);
    expect(error).toBeNull();

    // A truncated JOIN side does not shorten the list — it MISLABELS the tail:
    // no subscription row reads as 'free', no member row as a household of
    // zero, no profile as an owner nobody can email.
    const last = customers.find((c) => c.familyId === families[OVER - 1]);
    expect(last).toBeDefined();
    expect(last?.status).toBe('active');
    expect(last?.memberCount).toBe(1);
    expect(last?.ownerEmail).toBe(`${users[OVER - 1]}@example.com`);
    expect(customers.filter((c) => c.status === 'free')).toHaveLength(0);
  });
});

describe('the push campaign suppression list', () => {
  it.each([CAP, 17])('the actual audience helper completes devices, profiles and suppressions under cap %i', async cap => {
    const { loadPushCampaignAudience } = await import('@/lib/marketing/push-audience');
    const db = createInMemorySupabase({ maxRows: cap });
    const users = ids('user', OVER);
    const devices = ids('device', OVER);
    db.seed('push_devices', users.map((user_id, index) => ({ id: devices[index], user_id, enabled: true })));
    db.seed('profiles', users.map(id => ({ id, email: `${id}@example.test` })));
    db.seed('marketing_suppressions', users.slice(0, -1).map(id => ({ email: `${id}@example.test` })));
    // A single-page device scan cannot see the only eligible owner. A partial
    // suppression scan would incorrectly include opted-out owners near the end.
    const short = await (db as unknown as DB).from('push_devices').select('user_id').eq('enabled', true);
    expect(short.data).toHaveLength(cap);
    expect(short.data?.map(row => row.user_id)).not.toContain(users.at(-1));
    expect(await loadPushCampaignAudience(db as unknown as DB)).toEqual([users.at(-1)]);
  });

  it('excludes an opted-out address that sits past the cap', async () => {
    // The send path itself needs a marketing admin session; what this pins is
    // the property that makes the read load-bearing — `selectPushRecipients`
    // excludes an address only by FINDING its row, so completeness of the read
    // IS the opt-out.
    const { selectPushRecipients } = await import('@/lib/marketing/push');
    const db = capped();
    const users = ids('user', OVER);
    db.seed('marketing_suppressions', users.map((id) => ({ email: `${id}@example.com` })));

    const { data: short } = await (db as unknown as DB).from('marketing_suppressions').select('email');
    const shortList = (short ?? []).map((r) => r.email);
    const emailByUser = Object.fromEntries(users.map((id) => [id, `${id}@example.com`]));
    const lastUser = users[OVER - 1];

    // Read short, the last opt-out is invisible and the campaign reaches them.
    expect(shortList).toHaveLength(CAP);
    expect(selectPushRecipients([lastUser], emailByUser, shortList)).toContain(lastUser);

    // Read whole — which is what the action now does — and they are excluded.
    const { readAll } = await import('@/lib/supabase/read-all');
    const { rows, error } = await readAll<{ email: string }>((from, to) =>
      (db as unknown as DB).from('marketing_suppressions').select('email').order('email').range(from, to));
    expect(error).toBeNull();
    expect(rows).toHaveLength(OVER);
    expect(selectPushRecipients([lastUser], emailByUser, rows.map((r) => r.email))).toEqual([]);
  });
});

describe('the email campaign suppression lookup', () => {
  it('excludes an unsubscribed address when the audience is larger than the cap', async () => {
    const { resolveRecipients } = await import('@/lib/marketing/send');
    const db = capped();
    const families = ids('fam', OVER);
    const users = ids('user', OVER);
    db.seed('families', families.map((id) => ({ id, name: id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })));
    db.seed('family_members', families.map((id, i) => ({ family_id: id, user_id: users[i], role: 'parent', is_active: true })));
    db.seed('profiles', users.map((id) => ({ id, email: `${id}@example.com` })));
    // What truncates is the RESPONSE, not the filter, so the condition is more
    // than a thousand MATCHES: a list on which over a thousand people have
    // unsubscribed. Suppress all but six of the audience.
    const unsubscribed = users.slice(0, OVER - 6).map((id) => `${id}@example.com`);
    expect(unsubscribed.length).toBeGreaterThan(CAP);
    db.seed('marketing_suppressions', unsubscribed.map((email) => ({ email })));

    const recipients = await resolveRecipients(db as unknown as DB, { segment_id: null });

    // Exactly the six who never unsubscribed, and not one person more. Read in
    // a single `.in()`, the response stops at 1,000 and the five suppressions
    // past it are mailed as if they had consented.
    expect(recipients.sort()).toEqual(users.slice(OVER - 6).map((id) => `${id}@example.com`).sort());
  });
});

describe('network contributions', () => {
  it('reads a household whole when the batch is larger than the cap', async () => {
    const db = capped();
    // Enough families that one `.in()` over all of them matches far more than
    // a thousand member rows: 400 households of four.
    const families = ids('fam', 400);
    db.seed('network_consent', families.map((id) => ({ family_id: id, enabled: true, scopes: {} })));
    db.seed('family_members', families.flatMap((familyId, f) => [
      { id: `m-${f}-0`, family_id: familyId, role: 'parent', is_active: true, birthday: '1990-01-01' },
      { id: `m-${f}-1`, family_id: familyId, role: 'adult', is_active: true, birthday: '1991-01-01' },
      { id: `m-${f}-2`, family_id: familyId, role: 'child', is_active: true, birthday: '2016-01-01' },
      { id: `m-${f}-3`, family_id: familyId, role: 'child', is_active: true, birthday: '2018-01-01' },
    ]));

    await runNetworkAggregation(db as unknown as DB, new Date('2026-09-07T11:00:00Z'));

    // Every family's features must reflect its four members. A truncated read
    // is indistinguishable from an empty household by construction — the
    // batch builder gives a family with no rows a valid empty contribution —
    // so the tail would be published with a household size of zero.
    const rows = db.table('network_contributions');
    expect(rows).toHaveLength(families.length);
    // Every household is identical, so every banded feature row must be too: a
    // size band for four, and the two child age bands. An empty household bands
    // differently and lists no children at all.
    const banded = new Set(rows.map((r) => {
      const f = r.features as { sizeBand?: string; childBands?: string[] } | null;
      return `${f?.sizeBand}:${(f?.childBands ?? []).join(',')}`;
    }));
    expect(banded.size).toBe(1);
    const only = [...banded][0];
    expect(only).not.toContain('undefined');
    expect(only.split(':')[1]).not.toBe('');
  });
});

describe('the marketing automation runner', () => {
  it('does not re-run a workflow for a subject whose run row sits past the cap', async () => {
    const db = capped();
    // Three lapsed customers — the `payment_failed` audience.
    const families = ids('fam', 3);
    const users = ids('user', 3);
    db.seed('families', families.map((id) => ({ id, name: id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' })));
    db.seed('family_members', families.map((id, i) => ({ family_id: id, user_id: users[i], role: 'parent', is_active: true })));
    db.seed('profiles', users.map((id) => ({ id, email: `${id}@example.com` })));
    db.seed('subscriptions', families.map((id) => ({
      family_id: id, plan: 'plus', status: 'past_due',
      created_at: '2026-01-01T00:00:00Z', current_period_end: '2026-06-01T00:00:00Z',
    })));
    db.seed('marketing_automation_workflows', [{
      id: 'wf-1', trigger: 'payment_failed', status: 'active', deleted_at: null, steps: [], run_count: 0,
    }]);
    // A workflow with history: one row per subject it has ever run for. The
    // already-run family's row is the LAST of them, so a read capped at
    // db-max-rows answers with the thousand in front of it and never sees it.
    db.seed('marketing_automation_runs', [
      ...ids('old', CAP).map((subject) => ({
        id: `run-${subject}`, workflow_id: 'wf-1', subject_key: subject, status: 'completed', metadata: {},
      })),
      { id: 'run-already', workflow_id: 'wf-1', subject_key: families[0], status: 'completed', metadata: {} },
    ]);

    const summary = await runAutomations(db as unknown as DB);

    // The two that had never run, and not the one that had. The runner's own
    // docstring promises a (workflow, family) pair runs once — and nothing
    // downstream would have caught a second: the insert's 23505 branch waits on
    // a unique constraint the schema does not define.
    expect(summary.runs).toBe(2);
    const forAlready = db.table('marketing_automation_runs').filter((r) => r.subject_key === families[0]);
    expect(forAlready).toHaveLength(1);
  });
});

// Keep the fake's cap honest: it must apply to `.limit()` too, because the
// server's does. `.limit(5000)` against a default project yields 1,000.
describe('a limit is not a bound', () => {
  it('caps a select that asked for more than the server allows', async () => {
    const db = capped();
    db.seed('families', ids('fam', 6500).map((id) => ({ id, timezone: 'UTC' })));
    const { data } = await (db as unknown as DB).from('families').select('id').limit(5000);
    expect(data).toHaveLength(CAP);
  });
});

// A guard rather than a reproduction: the scanner below would have caught all
// four call sites this file fixes, and catches the next one.
describe('no delivery-contract read is left unbounded', () => {
  const WATCHED: { file: string; table: string; why: string }[] = [
    { file: 'lib/briefing/deliver.ts', table: 'families', why: 'one morning brief per family, from the cron' },
    { file: 'lib/network/aggregate-server.ts', table: 'network_consent', why: 'drives a not-in DELETE of contributions' },
    { file: 'lib/marketing/customers.ts', table: 'subscriptions', why: 'joined onto every family row' },
    { file: 'lib/marketing/customers.ts', table: 'family_members', why: 'joined onto every family row' },
    { file: 'lib/marketing/customers.ts', table: 'profiles', why: 'joined onto every family row' },
    { file: 'lib/marketing/push-audience.ts', table: 'push_devices', why: 'the campaign audience' },
    { file: 'lib/marketing/push-audience.ts', table: 'marketing_suppressions', why: 'a missing row sends to someone who opted out' },
    { file: 'lib/marketing/send.ts', table: 'marketing_suppressions', why: 'a missing row emails someone who unsubscribed' },
    { file: 'lib/marketing/automation-runner.ts', table: 'marketing_automation_runs', why: 'the only guard against re-running a workflow for the same family' },
    // Source-level rather than behavioural, because the cron routes read their
    // auth and service client at module scope and no test in the repo invokes
    // one — the two existing allowance cron tests assert on the source for the
    // same reason. The consequence is the sharpest in this file: a plan row
    // that does not come back is not read as unknown, it is read as free, and
    // the child's allowance is SKIPPED while the run reports itself clean.
    { file: 'app/api/cron/wallet-allowance/route.ts', table: 'subscriptions', why: 'a plan that does not come back skips a child\'s allowance' },
    { file: 'app/api/cron/chore-reminders/route.ts', table: 'families', why: 'every family with an open chore, in one request line' },
    // Not a delivery contract but a safety one, which is the same argument with
    // more at stake: the row that falls past the cap is the allergy, and a
    // missing allergy row is not read as unknown — it is read as "no allergy".
    { file: 'lib/services/groceries/index.ts', table: 'family_facts', why: 'a missing allergy row puts the allergen on the shopping list' },
    { file: 'lib/services/meals/index.ts', table: 'family_facts', why: 'feeds the "ALLERGIES (never serve)" line the planner is given' },
  ];

  it.each(WATCHED)('$file reads $table whole ($why)', async ({ file, table }) => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    // A PostgREST chain is one STATEMENT, not one line — `.range()` routinely
    // wraps onto the next. So take each `from('<table>')` through to the `;`
    // that ends its statement and judge the whole chain.
    const marker = `from('${table}')`;
    const chains: string[] = [];
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
      const end = source.indexOf(';', at);
      chains.push(source.slice(at, end === -1 ? source.length : end));
    }
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      // Either the read pages (`.range(from, to)`, normally inside a `readAll`
      // callback) or it is not an unbounded read at all: a write chain, or a
      // read already bounded to one owner's rows by an explicit `.limit()`.
      const isWrite = /\.(insert|update|upsert|delete)\(/.test(chain);
      // Bounded means the response cannot reach the cap: it pages (`.range()`),
      // it asks for a fixed few (`.limit()`), or it is a `readInChunks`
      // callback, whose batch of at most 100 ids can never match 1,000 rows.
      const isBounded = chain.includes('.range(') || chain.includes('.limit(') || /\.in\('[a-z_]+', chunk\)/.test(chain);
      expect(isWrite || isBounded, `unbounded read of ${table}: ${chain.replace(/\s+/g, ' ').slice(0, 160)}`).toBe(true);
    }
  });
});

// readAllInChunks is now load-bearing for the nightly aggregation, so measure
// it directly rather than only through its callers.
describe('readAllInChunks', () => {
  it('returns every row when each chunk holds more than one page', async () => {
    const { readAllInChunks } = await import('@/lib/supabase/chunked-in');
    // 250 owners, 12 rows each: more than one chunk, and each chunk of 100
    // owners is 1,200 rows — over the cap a single page could return.
    const owners = ids('owner', 250);
    const rows = owners.flatMap((owner, i) =>
      Array.from({ length: 12 }, (_, j) => ({ id: `r-${String(i).padStart(4, '0')}-${j}`, owner })));

    const { data, error } = await readAllInChunks<{ id: string; owner: string }>(owners, (chunk, from, to) => {
      const matching = rows.filter((r) => chunk.includes(r.owner));
      // A server that caps every response, exactly as PostgREST does.
      return Promise.resolve({ data: matching.slice(from, Math.min(to + 1, from + CAP)), error: null });
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(owners.length * 12);
  });

  it('returns no rows at all when a chunk fails', async () => {
    const { readAllInChunks } = await import('@/lib/supabase/chunked-in');
    const owners = ids('owner', 150);

    const { data, error } = await readAllInChunks<{ id: string }>(owners, (chunk, from) =>
      Promise.resolve(chunk.includes(owners[149])
        ? { data: null, error: { message: 'offline' } }
        // One row, then an empty page to end the healthy chunk honestly.
        : { data: from === 0 ? [{ id: 'a' }] : [], error: null }));

    // For a caller that aggregates per owner, a partial answer is not a smaller
    // answer — it is a wrong one attributed to the owners that did come back.
    expect(error).toEqual({ message: 'offline' });
    expect(data).toBeNull();
  });
});

// A hand-rolled stub, so the assertions above cannot be explained by the fake.
describe('readAll against a hand-rolled capping server', () => {
  it('advances by rows received, not by the range requested', async () => {
    const { readAll } = await import('@/lib/supabase/read-all');
    const rows = ids('row', 2011).map((id) => ({ id }));
    const page = vi.fn(async (from: number, to: number) => ({
      data: rows.slice(from, Math.min(to + 1, from + CAP)),
      error: null,
    }));
    const { rows: got, error } = await readAll<{ id: string }>(page);
    expect(error).toBeNull();
    expect(got).toHaveLength(2011);
  });
});
