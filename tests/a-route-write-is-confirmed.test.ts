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
