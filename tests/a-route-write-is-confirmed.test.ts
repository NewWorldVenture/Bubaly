import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C1-S9-62 — the first tranche of the unconfirmed-write class OUTSIDE
 * server actions: API routes a person or a scheduler calls directly.
 *
 * Same rule as the server-action sweep: fix what gives a DIFFERENT answer, log
 * what gives a SMALLER one, and where zero rows is ordinary, assert the ABSENCE
 * of a check with the reason beside the code.
 */
const read = (p: string) => readFileSync(p, 'utf8');
/** Line comments only, keeping line structure. */
const code = (s: string) => s.replace(/^[^\S\n]*\/\/.*$/gm, '');
/** From `needle` to the brace closing the block it opens. */
function block(src: string, needle: string): string {
  const start = at(src, needle);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced after ${needle}`);
}

const cancel = read('app/api/billing/cancel/route.ts');
const changePlan = read('app/api/billing/change-plan/route.ts');
const subscribe = read('app/api/blog/subscribe/route.ts');
const unsubscribe = read('app/api/blog/unsubscribe/route.ts');
const pushUnsub = read('app/api/push/unsubscribe/route.ts');
const syncDisconnect = read('app/api/sync/[provider]/disconnect/route.ts');
const googleDisconnect = read('app/api/sync/google/disconnect/route.ts');
const place = read('app/api/concierge-calls/place/route.ts');
const like = read('app/api/blog/like/route.ts');
const save = read('app/api/blog/save/route.ts');
const briefing = read('app/api/ai/briefing/route.ts');
const chat = read('app/api/ai/chat/route.ts');
const track = read('app/api/mkt/track/route.ts');
const weekend = read('app/api/weekend/discover/route.ts');

describe('billing sync after Stripe has changed (C1-S9-62)', () => {
  it('cancel: a sync matching no rows takes the existing 503, not ok', () => {
    const b = block(cancel, 'if (syncError || wroteNoRows(synced)) {');
    expect(b).toContain("t('cancel.stripeUpdatedTheSubscriptionBut'), providerUpdated: true");
    expect(cancel).toContain(".eq('family_id', familyId)\n      .select('id');");
  });

  it('change-plan: the same, proved behaviourally in billing-price-verification', () => {
    expect(changePlan).toContain("if (wroteNoRows(synced)) throw new Error('subscription sync matched no rows');");
    expect(read('tests/billing-price-verification.test.ts')).toContain("'matchedNone'");
  });
});

describe('newsletter consent (C1-S9-62)', () => {
  it('re-subscribing a row that vanished falls through to a fresh insert', () => {
    const b = block(subscribe, 'if (existing) {');
    expect(b).toContain("if (!wroteNoRows(reactivated)) return NextResponse.json({ ok: true, already: false });");
    // Zero rows must NOT return inside the block — it has to reach the insert.
    expect(code(b).match(/return NextResponse\.json\(\{ ok: true/g)).toHaveLength(2);
    expect(at(subscribe, "from('blog_subscribers')\n    .insert(")).toBeGreaterThan(at(subscribe, 'if (existing) {') + b.length);
  });

  it('unsubscribing stays ungated on rows — gone is unsubscribed', () => {
    const w = unsubscribe.slice(at(unsubscribe, 'const { error: writeError }'));
    expect(w.slice(0, 220)).not.toContain('.select(');
    expect(unsubscribe).toContain('a person with no row is not on the list');
  });

  it('push unsubscribe stays ungated on rows — RLS cannot refuse a matching row', () => {
    const w = pushUnsub.slice(at(pushUnsub, ".from('push_devices')\n    .delete()"));
    expect(w.slice(0, 160)).not.toContain('.select(');
    expect(pushUnsub).toContain('`push_devices_delete` (0035) is');
  });
});

describe('disconnects run on the service role (C1-S9-62)', () => {
  for (const [name, src] of [['provider', syncDisconnect], ['google', googleDisconnect]] as const) {
    it(`${name}: the delete checks its error and deliberately not its rows`, () => {
      const w = src.slice(at(src, "const { error: deleteError } = await admin.from('sync_accounts').delete()"));
      expect(w.split('\n')[0]).not.toContain('.select(');
      expect(w).toContain('if (deleteError) {');
      expect(src).toContain('an account whose row is already gone IS disconnected');
      expect(src).toContain('const admin = createServiceClient();');
    });
  }
});

describe('concierge calls count only what moved (C1-S9-62)', () => {
  it('parked is incremented only when the status guard let a row through', () => {
    expect(place).toContain(".eq('id', r.id).eq('status', 'queued')\n      .select('id');");
    expect(place).toContain('if (!wroteNoRows(moved)) parked++;');
    expect(code(place)).not.toMatch(/^\s*parked\+\+;/m);
  });
});

describe('best-effort writes keep their error (C1-S9-62)', () => {
  it('blog like/save toggles log a failed delete, and stay ungated on rows', () => {
    for (const [src, binding] of [[like, 'unlikeError'], [save, 'unsaveError']] as const) {
      expect(src, binding).toContain(`const { error: ${binding} }`);
      expect(src, binding).toContain(`if (${binding}) console.error(`);
      const w = src.slice(at(src, `const { error: ${binding} }`));
      expect(w.split('\n')[0], binding).not.toContain('.select(');
    }
  });

  it('weekend feed bookkeeping logs its error', () => {
    expect(weekend).toContain("if (statusError) console.error('[weekend/discover] feed status write failed'");
  });

  it('chat metadata is confirmed for the log and never fails the turn', () => {
    const b = code(block(chat, 'if (titleUpdateError || wroteNoRows(titled)) {'));
    expect(b).toContain("'[ai-chat] conversation metadata update failed'");
    expect(b).not.toMatch(/\breturn\b|\bthrow\b|send\(/);
  });

  it('tracking reports a vanished visitor at the write that found it', () => {
    const b = block(track, 'if (updateError || wroteNoRows(touched)) {');
    expect(b).toContain("t('track.analyticsIsTemporarilyUnavailable')");
    expect(b).toContain('status: 503');
  });

  it('the briefing mark-read stays ungated on rows, with its reason', () => {
    const w = briefing.slice(at(briefing, "const { error: markError } = await supabase"));
    expect(w.slice(0, 260)).not.toContain('.select(');
    expect(briefing).toContain('zero rows means they were already read');
  });
});

/**
 * Audit C1-S9-63 — the rest of the API routes: a live-call webhook, a trip
 * builder's rollback, and the crons.
 */
const screen = read('app/api/guardian/screen/route.ts');
const vacations = read('app/api/vacations/ai/route.ts');
const routines = read('app/api/cron/family-routines/route.ts');
const aiRuns = read('app/api/cron/ai-runs/route.ts');

describe('a live call never bails, and never discards a write (C1-S9-63)', () => {
  const sites = [
    ['historySaved', 'historyError', 'transcript save failed'],
    ['summarised', 'summaryError', 'voicemail summary save failed'],
    ['resolved', 'resolveError', 'session resolve failed'],
    ['handled', 'handledError', 'communication handled-stamp failed'],
  ] as const;
  for (const [rows, err, log] of sites) {
    it(`${rows}: logged on error or zero rows, and nothing leaves the handler`, () => {
      const b = code(block(screen, `if (${err} || wroteNoRows(${rows})) {`));
      expect(b, rows).toContain(log);
      // A return or throw here would drop the caller mid-screening.
      expect(b, rows).not.toMatch(/\breturn\b|\bthrow\b/);
    });
  }

  it('no screening write discards its result any more', () => {
    expect(code(screen)).not.toMatch(/^\s*await gFrom\([^)]*\)\s*\.update\(/m);
  });
});

describe('a failed trip build is rolled back and counted (C1-S9-63)', () => {
  it('rollback deletes compare what they removed with what this request created', () => {
    expect(vacations).toContain("else if ((removed?.length ?? 0) !== ids.length) {");
    expect(vacations).toContain(".in('id', ids).select('id');");
  });

  it('the budget restore reports a restore that matched nothing', () => {
    expect(vacations).toContain('else if (wroteNoRows(restoredBudget)) {');
  });

  it('the recommendation clear stays ungated on rows, with its reason', () => {
    const w = vacations.slice(at(vacations, "const { error: deleteError } = await supabase.from('vacation_ai_recommendations').delete()"));
    expect(w.split('\n')[0]).not.toContain('.select(');
    expect(vacations).toContain('on a first run there is\n    // no prior set');
  });
});

describe('the routine cron only counts what landed (C1-S9-63)', () => {
  it('every routine_runs stamp goes through one confirmed helper', () => {
    const helper = block(routines, 'async function stampRun(');
    expect(helper).toContain(".eq('due_at', dueAt).select('id');");
    expect(helper).toContain('if (error || wroteNoRows(data)) {');
    expect(code(helper)).not.toMatch(/\breturn\b|\bthrow\b/);
    // And no stamp bypasses it.
    expect(code(routines).match(/from\('routine_runs'\)\s*\.update\(/g) ?? []).toHaveLength(1);
    expect(code(routines).match(/await stampRun\(/g) ?? []).toHaveLength(4);
  });

  it('the helper is typed by the table, not cast', () => {
    expect(routines).toContain("patch: Database['public']['Tables']['routine_runs']['Update'],");
    expect(block(routines, 'async function stampRun(')).not.toMatch(/as never|as any|as string/);
  });

  it('the rule reschedules stay ungated on rows — a deleted rule cannot wedge', () => {
    const reschedules = code(routines).match(/from\('family_automation_rules'\)\s*\.update\(\{ next_run_at: [^}]*last_run_at[^;]*;/g) ?? [];
    expect(reschedules).toHaveLength(3);
    for (const r of reschedules) expect(r).not.toContain('.select(');
  });
});

describe('ai-runs counts a run as returned only when it was (C1-S9-63)', () => {
  it('neither an error nor the state guard declining is counted', () => {
    expect(aiRuns).toContain(".eq('state', 'executing')\n            .select('id');");
    expect(aiRuns).toContain('else if (!wroteNoRows(requeued)) returned += 1;');
    expect(code(aiRuns)).not.toMatch(/^\s*returned \+= 1;/m);
  });
});

describe('crons whose zero rows means the row is gone stay ungated (C1-S9-63)', () => {
  const cases = [
    ['app/api/cron/return-reminders/route.ts', "update({ overdue_notified_at: nowIso }).eq('id', o.id)", 'which no run will sweep'],
    ['app/api/cron/wallet-allowance/route.ts', ".from('allowance_rules')\n          .update({ next_run_on: rule.next_run_on", 'no schedule to restore'],
    ['app/api/cron/checkout-abandoned/route.ts', ".update({ status: 'abandoned', abandoned_at: new Date().toISOString() })", 'a gone row is not swept again'],
    ['app/api/cron/guardian-learning/route.ts', ".update({ status: 'auto_dismissed' })", 'ordinary "nothing expired" tick'],
  ] as const;
  for (const [file, write, reason] of cases) {
    it(file, () => {
      const src = read(file);
      const stmt = src.slice(at(src, write));
      expect(stmt.slice(0, stmt.indexOf(';')), file).not.toContain('.select(');
      expect(src, file).toContain(reason);
    });
  }
});

/**
 * Audit C1-S9-64 — the money code in lib/: Stripe mirrors, a wallet hold, and
 * a referral rollback.
 */
const connect = read('lib/stripe/connect.ts');
const issuing = read('lib/stripe/issuing.ts');
const treasury = read('lib/stripe/treasury.ts');
const moneyWebhook = read('lib/stripe/webhook.ts');
const walletServer = read('lib/wallet/server.ts');
const referrals = read('lib/referrals/server.ts');

describe('the connected-account mirror no longer discards its result (C1-S9-64)', () => {
  it('throws on a refused write, so every caller — and Stripe — can react', () => {
    const fn = block(connect, 'export async function syncConnectedAccount(');
    expect(fn).toContain("if (error) throw new Error('Stripe connected-account mirror update failed');");
    expect(fn).toContain(".eq('family_id', familyId)\n    .select('id');");
  });

  it('logs, and does NOT throw, when no mirror row matched', () => {
    // Throwing there would have Stripe retry for days an event nothing can apply.
    const b = code(block(connect, 'if (wroteNoRows(mirrored)) {'));
    expect(b).toContain('console.error(');
    expect(b).not.toMatch(/\bthrow\b/);
  });
});

describe('card mirrors log a no-op as well as an error (C1-S9-64)', () => {
  for (const binding of ['controlled', 'frozenRow']) {
    it(binding, () => {
      const b = code(block(issuing, `if (error || wroteNoRows(${binding})) {`));
      expect(b, binding).toContain('issuing_card.updated reconciles it');
      // The control took effect at Stripe; telling the parent it failed would
      // be the more misleading answer of the two.
      expect(b, binding).not.toMatch(/\bthrow\b|\breturn\b/);
    });
  }

  it('the webhook card mirror stays ungated on rows, with its reason', () => {
    const w = moneyWebhook.slice(at(moneyWebhook, ".from('stripe_issuing_cards')\n    .update(cardMirrorFromStripe(card))"));
    expect(w.slice(0, w.indexOf(';'))).not.toContain('.select(');
    expect(moneyWebhook).toContain('there is nothing left to\n  // mirror');
  });

  it('the treasury balance cache logs its error and still returns Stripe\'s figure', () => {
    expect(treasury).toContain("if (cacheError) console.error('[money] treasury balance cache write failed'");
    const fn = treasury.slice(at(treasury, "if (cacheError) console.error("));
    expect(fn.slice(0, 200)).toContain('return cash;');
  });
});

describe('a wallet hold release and a referral rollback (C1-S9-64)', () => {
  it('releasing a card hold stays ungated — the second call is meant to be a no-op', () => {
    const fn = block(walletServer, 'export async function releaseCardHold(');
    expect(code(fn)).not.toContain('.select(');
    expect(fn).toContain('Zero rows means the hold is already released');
    expect(fn).toContain("if (error) throw new Error(walletFailure(error,");
  });

  it('both referral rollback writes log a no-op, never raise', () => {
    for (const binding of ['dropped', 'unstamped']) {
      const b = code(block(referrals, `wroteNoRows(${binding})) {`));
      expect(b, binding).toContain("console.error('[referrals/email] invite rollback");
      expect(b, binding).not.toMatch(/\bthrow\b|\breturn\b/);
    }
  });
});
