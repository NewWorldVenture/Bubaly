import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 0295 reward-redemption decision guard — the third sibling of 0222's
 * submission guard and 0223's chore-assignment guard.
 *
 * `reward_redemptions` shipped (0028) with one `FOR ALL … is_family_member`
 * policy and no trigger, and BOTH of its write paths are direct browser writes
 * that choose `status` and `decided_by` client-side: `redeem()` in
 * chores-module, `requestReward()` and `decide()` in rewards-module. The
 * client picked 'approved' for a manager and 'requested' otherwise — so a child
 * calling PostgREST could insert a redemption already approved, or approve one
 * sitting in the queue, self-granting a reward no parent agreed to.
 *
 * Like its two siblings it mints no money: the points economy is separate from
 * the wallet, which is manager-only under 0217. It is an accountability forgery.
 *
 * Proven live on a PG16 harness before it was written down: child insert-as-
 * approved blocked, child approve-from-queue blocked, child mark-fulfilled
 * blocked, child request and child cancel allowed, parent approve and fulfil
 * allowed, trusted server allowed. Dropping the trigger fails the probe on the
 * first case. `docs/audit/reward-redemption-decision-check.sql` is that proof,
 * and CI runs it against the fully replayed schema on every pull request.
 */
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_reward_redemption_decision_guard.sql'));
  expect(files.length, 'reward_redemption_decision_guard migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0295 reward redemption decision guard', () => {
  const sql = migration();

  it('guards the three statuses a parent decides', () => {
    expect(sql).toContain("new.status in ('approved','rejected','fulfilled')");
  });

  it('leaves asking, waiting and withdrawing to the member', () => {
    // A guard that also blocked 'requested' would break the queue it protects,
    // and one that blocked 'cancelled' would trap a child's own withdrawn ask.
    //
    // Asserted against the guard CONDITION, not the file: the header explains
    // which statuses stay open and names them, so a whole-file match reads its
    // own documentation as if it were code. That is how a source assertion goes
    // wrong in the other direction.
    const guarded = sql.match(/new\.status in \(([^)]*)\)/)?.[1] ?? '';
    expect(guarded, 'the guarded status list').not.toBe('');
    for (const memberStatus of ['requested', 'pending', 'cancelled']) {
      expect(guarded).not.toContain(memberStatus);
    }
  });

  it('guards both INSERT and UPDATE transitions', () => {
    // Insert alone would miss `decide()`, which updates a queued row; update
    // alone would miss `redeem()`, which inserts one already approved.
    expect(sql).toContain("(tg_op = 'INSERT' or new.status is distinct from old.status)");
    expect(sql).toContain('before insert or update on public.reward_redemptions');
  });

  it('allows managers and the trusted server, blocks plain members', () => {
    expect(sql).toContain("current_user = 'service_role'");
    expect(sql).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(sql).toContain('auth.uid() is null');
    expect(sql).toContain('public.can_manage_family(new.family_id)');
    expect(sql).toContain('may only be set by a family manager');
    expect(sql).toContain("errcode = '42501'");
  });

  it('runs as security invoker and is idempotent', () => {
    expect(sql).toContain('security invoker');
    expect(sql).toContain("to_regclass('public.reward_redemptions') is null");
    expect(sql).toContain('drop trigger if exists trg_reward_redemption_decision_guard');
  });

  it('ships the behavioural probe CI runs against the real schema', () => {
    // The source assertions above cannot observe a trigger; the probe can, and
    // globbing means it runs without anyone registering it.
    const probe = readFileSync('docs/audit/reward-redemption-decision-check.sql', 'utf8');
    expect(probe).toContain('a child inserted an APPROVED reward redemption');
    expect(probe).toContain('a child approved their own queued reward redemption');
    expect(probe).toContain('a parent could not approve and fulfil a reward redemption');
  });
});
