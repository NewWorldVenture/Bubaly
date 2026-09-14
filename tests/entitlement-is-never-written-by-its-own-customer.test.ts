import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// 0306 is the real boundary: `subscriptions` and `billing_customers` take no
// client write at all, proven behaviourally by
// docs/audit/paywall-write-boundary-check.sql. This pins the SECOND lock on the
// same door — the code side, which reaches production FIRST.
//
// That ordering is the whole reason this file exists. F5 means migrations are
// not applied on merge in this repo, so a route that starts writing one of
// these tables with the caller's own session ships before any policy could
// refuse it. And once 0306 IS applied, such a write does not merely leak — it
// fails, at a point where the family has already been charged by Stripe.
//
// The rule is not "these tables are untouchable". It is that the WRITE is the
// server's: `createServiceClient()`, never the request-scoped `createServer()`
// client, because the value being written is what the paywall reads back, and
// on billing_customers it is what /api/billing/portal hands to Stripe.
//
// Asserted against the repo's own text rather than through a mocked client: a
// mocked Supabase client proves the mock. What matters here is which client a
// call site chose, and that is a property of the source.

/** Every `.from('<table>')` in app/ and lib/, with the file it sits in. */
function callSites(table: string): { file: string; line: number; text: string }[] {
  const out = execFileSync(
    'grep',
    ['-rn', '--include=*.ts', '--include=*.tsx', `from('${table}')`, 'app', 'lib'],
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [file, line, ...rest] = row.split(':');
      return { file, line: Number(line), text: rest.join(':') };
    });
}

/**
 * The write verbs PostgREST exposes. A `.select(...)` alone is a read and is
 * deliberately still allowed from the caller's session — a member sees their
 * family's plan, and `subs_select` still says so.
 */
const WRITE_VERBS = ['.insert(', '.update(', '.upsert(', '.delete('];

/**
 * The statement a call site belongs to. `.from('x')` and the verb are usually
 * on the same line but not always, so take the text from the `.from(` to the
 * end of that statement rather than the line.
 */
function statementAt(source: string, index: number): string {
  const semicolon = source.indexOf(';', index);
  return source.slice(index, semicolon === -1 ? source.length : semicolon);
}

/**
 * The RECEIVER of a `.from(...)` — the client the query was built on. It sits
 * BEFORE the match, which is the whole difficulty: reading forward from
 * `.from(` can never see which client was chosen. Reads backwards over the
 * whitespace and the dot to the identifier or call that precedes them, so both
 * `createServiceClient().from(...)` and a multi-line
 *
 *   await supabase
 *     .from('subscriptions')
 *
 * resolve to the same thing.
 */
function receiverBefore(source: string, index: number): string | null {
  const before = source.slice(Math.max(0, index - 200), index);
  return before.match(/([A-Za-z_$][\w$]*(?:\(\))?)\s*\.\s*$/)?.[1] ?? null;
}

/**
 * What a local name was last bound to before this point in the file. A single
 * file legitimately holds both clients — app/api/billing/change-plan/route.ts
 * reads with `createServer()` and writes the sync with `createServiceClient()`
 * — so the binding has to be resolved at the call site, not per file.
 */
function boundClientAt(source: string, name: string, index: number): string | null {
  const pattern = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:await\\s+)?(create\\w+)\\(`, 'g');
  let last: string | null = null;
  for (const match of source.matchAll(pattern)) {
    if (match.index !== undefined && match.index < index) last = match[1];
  }
  if (last) return last;

  // A PARAMETER annotated `ReturnType<typeof createServiceClient>` — the shape
  // app/api/webhooks/stripe/route.ts uses for its persist helpers. This is a
  // stronger guarantee than a local binding, not a weaker one: the type system
  // refuses a request-scoped client at every call site, where a local binding
  // is only as good as the line that wrote it.
  const typed = new RegExp(`${name}\\s*:\\s*ReturnType<\\s*typeof\\s+(create\\w+)\\s*>`);
  return source.match(typed)?.[1] ?? null;
}

type Write = { file: string; statement: string; client: string | null };

function writeStatements(table: string): Write[] {
  const found: Write[] = [];
  for (const file of new Set(callSites(table).map((c) => c.file))) {
    const source = readFileSync(file, 'utf8');
    let at = source.indexOf(`from('${table}')`);
    while (at !== -1) {
      const statement = statementAt(source, at);
      if (WRITE_VERBS.some((verb) => statement.includes(verb))) {
        const receiver = receiverBefore(source, at);
        const client = receiver === null ? null
          : receiver.endsWith('()') ? receiver.slice(0, -2)
          : boundClientAt(source, receiver, at);
        found.push({ file, statement, client });
      }
      at = source.indexOf(`from('${table}')`, at + 1);
    }
  }
  return found;
}

describe('the row that decides what a family paid for is never written by that family', () => {
  for (const table of ['subscriptions', 'billing_customers']) {
    it(`writes ${table} only through the service-role client`, () => {
      const offenders = writeStatements(table)
        .filter(({ client }) => client !== 'createServiceClient')
        .map(({ file, statement, client }) =>
          `${file} (built on ${client ?? 'an unrecognised client'}): `
          + statement.replace(/\s+/g, ' ').slice(0, 100));

      expect(
        offenders,
        `${table} is written from the caller's own session. 0306 revokes that write, `
          + 'so this fails at runtime after the customer has already been charged — and '
          + 'before 0306 reaches a database, it is the paywall (and, on billing_customers, '
          + "another family's Stripe portal) written by the person it is meant to bill. "
          + 'Use createServiceClient().',
      ).toEqual([]);
    });

    it(`still has a write path for ${table} at all`, () => {
      // Guards the guard: an assertion that passes because nothing writes the
      // table any more would be worthless the day the grep string changes.
      expect(writeStatements(table).length).toBeGreaterThan(0);
    });
  }

  it('leaves reads on the caller session, because a member may see their own plan', () => {
    // `lib/server/entitlement.ts` reads subscriptions with the request-scoped
    // client on purpose, to show the family its plan. If this ever became a
    // service-role read, `subs_select` would stop being the thing that decides
    // who sees a plan, and nobody would notice.
    const entitlement = readFileSync('lib/server/entitlement.ts', 'utf8');
    expect(entitlement).toContain("supabase.from('subscriptions')");
    expect(entitlement).not.toContain('createServiceClient');
  });

  it('keeps trial_ends_at and closed_at off the caller session too', () => {
    // These two columns are entitlement wearing a profile table's clothes:
    // `lib/server/plan.ts` reads them with the service role and treats them as
    // authority, so 0306 pins them with a trigger. Both writers already use the
    // service role; this says so out loud.
    const account = readFileSync('app/(app)/account/actions.ts', 'utf8');
    expect(account).toContain('createServiceClient');
    expect(account).not.toMatch(/createServer\(\)[\s\S]{0,400}closed_at/);
  });
});
