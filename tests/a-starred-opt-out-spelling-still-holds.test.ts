// An opt-out stored under a spelling with a literal `*` stops the inbox's mail.
//
// The automation sender finds older opt-outs stored under another spelling of
// the same inbox (`p*q+news@example.com` for `p*q@example.com`) with a LIKE scan,
// then compares canonical inboxes exactly (lib/marketing/automation-steps.ts).
// The scan escaped the address with escapeLike, which writes a star as `\*`.
// PostgREST replaces every `*` in a like value with `%` before PostgreSQL sees
// it, backslash or not, so `\*` arrived as `\%`, a literal percent sign. The
// scan returned `p%q+news@example.com`, missed the starred row, the exact
// comparison rejected the neighbour, and the opted-out inbox was mailed.
// Reproduced by review on #1028 against PostgREST 16.4 and PostgreSQL 18.4.
//
// The in-memory database reads a backslash as an ordinary character and leaves
// `*` alone, so it cannot show this. Here the scan's pattern goes through the
// two steps the server applies (PostgREST's star rewrite, then PostgreSQL LIKE
// with its default backslash escape), and the rows that match are the rows the
// sender reads. Driven through the real runSteps; only the provider is fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));

vi.mock('@/lib/email', () => ({
  getResend: () => ({
    emails: {
      send: async (message: Record<string, unknown>) => {
        h.sent.push(message);
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));

/** PostgREST's like value as PostgreSQL receives it, matched as SQL LIKE does. */
function serverLike(value: string, pattern: string): boolean {
  const sent = pattern.replaceAll('*', '%');
  let source = '';
  for (let i = 0; i < sent.length; i += 1) {
    let char = sent[i];
    if (char === '\\' && i + 1 < sent.length) {
      char = sent[(i += 1)];
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    source += char === '%' ? '[\\s\\S]*' : char === '_' ? '[\\s\\S]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(value);
}

/** The in-memory client, with `.like()` answered the way the server answers it. */
function withServerLike(db: InMemorySupabase, patterns: string[]) {
  const wrap = (builder: object, table: string): object => new Proxy(builder, {
    get(target, prop) {
      if (prop === 'like') {
        return (column: string, pattern: string) => {
          patterns.push(pattern);
          const matched = db.table(table).map((row) => row[column]).filter((v): v is string => typeof v === 'string' && serverLike(v, pattern));
          return wrap((target as { in: (c: string, v: string[]) => object }).in(column, matched), table);
        };
      }
      const member = Reflect.get(target, prop);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const out = member.apply(target, args);
        return out && typeof out === 'object' && typeof (out as { like?: unknown }).like === 'function' ? wrap(out, table) : out;
      };
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'from') return (table: string) => wrap(target.from(table) as object, table);
      return Reflect.get(target, prop);
    },
  });
}

let db: InMemorySupabase;
let patterns: string[];

async function run(email: string): Promise<string[]> {
  const { runSteps } = await import('@/lib/marketing/automation-steps');
  return runSteps([{ action: 'send_email' }], { email, name: 'Ana' }, { subject: 'Hello', body: 'A note.' }, withServerLike(db, patterns) as never);
}

const optOuts = (...emails: string[]) => db.seed('marketing_suppressions', emails.map((email) => ({ email, reason: 'unsubscribe' })));

beforeEach(() => {
  vi.stubEnv('INTERNAL_SECRET', 'starred-opt-out-fixture');
  h.sent = [];
  patterns = [];
  db = createInMemorySupabase();
});

describe('the server-side LIKE model is faithful', () => {
  it('reads an escaped star as a literal percent sign and an escaped percent the same way', () => {
    expect(serverLike('p%q+news@example.com', 'p\\*q%@example.com%')).toBe(true);
    expect(serverLike('p*q+news@example.com', 'p\\*q%@example.com%')).toBe(false);
    expect(serverLike('p%q+news@example.com', 'p\\%q%@example.com%')).toBe(true);
    expect(serverLike('pxq+news@example.com', 'p\\%q%@example.com%')).toBe(false);
    expect(serverLike('p*q+news@example.com', 'p_q%@example.com%')).toBe(true);
  });
});

describe('an opt-out stored under a starred spelling holds for the inbox', () => {
  it('a legacy +tag opt-out with a star in the local part stops the mail', async () => {
    optOuts('p*q+news@example.com');
    expect(await run('p*q@example.com')).toEqual(['send_email:suppressed']);
    expect(h.sent).toEqual([]);
    expect(patterns).toEqual(['p_q%@example.com%']);
  });

  it('holds when the percent-sign neighbour is stored beside it', async () => {
    optOuts('p%q+news@example.com', 'p*q+news@example.com');
    expect(await run('p*q@example.com')).toEqual(['send_email:suppressed']);
    expect(h.sent).toEqual([]);
  });

  it('a star in the domain is matched too', async () => {
    optOuts('ann+news@st*r.example.');
    expect(await run('ann@st*r.example')).toEqual(['send_email:suppressed']);
    expect(h.sent).toEqual([]);
  });

  it('a starred Gmail spelling with dots and a tag stops the mail', async () => {
    optOuts('p.*q+news@googlemail.com');
    expect(await run('p*q@gmail.com')).toEqual(['send_email:suppressed']);
    expect(h.sent).toEqual([]);
  });

  it('a neighbour the star lets into the scan does not suppress (control)', async () => {
    optOuts('p%q+news@example.com', 'pxq+news@example.com', 'p_q@example.com');
    expect(await run('p*q@example.com')).toEqual(['send_email']);
    expect(h.sent).toHaveLength(1);
  });

  it('a percent sign in the address stays escaped (control)', async () => {
    optOuts('pxq+news@example.com');
    expect(await run('p%q@example.com')).toEqual(['send_email']);
    expect(patterns).toEqual(['p\\%q%@example.com%']);
    optOuts('p%q+news@example.com');
    expect(await run('p%q@example.com')).toEqual(['send_email:suppressed']);
    expect(h.sent).toHaveLength(1);
  });

  it('an ordinary +tag opt-out still stops the mail through the same model (control)', async () => {
    optOuts('reader+news@example.com');
    expect(await run('reader@example.com')).toEqual(['send_email:suppressed']);
    expect(h.sent).toEqual([]);
  });
});
