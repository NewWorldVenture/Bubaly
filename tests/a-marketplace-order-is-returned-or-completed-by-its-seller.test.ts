import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';
import { SELLER_ONLY_ORDER_STEPS, mayTakeOrderStep } from '@/lib/marketplace/order-lifecycle';

// setOrderStatusAction makes `returned` and `completed` the seller's steps, but
// the database let either party write `status` (and `returned_at`) straight
// through PostgREST: marketplace_orders_update (0483) admits both parties, and
// nothing froze the status. So a borrower PATCHed their borrow to `returned`
// while still holding it (ending its overdue reminders), and a buyer completed
// a sale never handed over. The held 0518 adds a BEFORE UPDATE guard refusing a
// client's change to either step, or of `returned_at`, unless the caller is the
// order's seller_member. The service role, session-less writers and the
// database's own SECURITY DEFINER functions (the in-person hand-off code either
// party may enter) are let through, which is why the guard is keyed on
// current_user inside a SECURITY INVOKER trigger (0458, 0482). The behaviour
// itself is proven by the probe and the runtime workflow; this pins the source.

const MIGRATION = 'supabase/reserved/0518_a_marketplace_order_is_returned_or_completed_by_its_seller.sql';
const PROBE = 'docs/audit/reserved/a-marketplace-order-is-returned-or-completed-by-its-seller-check.sql';
const WORKFLOW = '.github/workflows/marketplace-order-finish-runtime.yml';
const RELEASED_PROBE = 'docs/audit/marketplace-ownership-update-check.sql';
const README = 'supabase/reserved/README.md';
const ACTIONS = 'app/(app)/marketplace/actions.ts';
const HANDOFF_RPC = 'supabase/migrations/0483_a_live_hold_counts_and_an_order_names_both_families.sql';

const SENTENCE = 'Only the seller marks a marketplace order returned or completed';

const sql = readFileSync(MIGRATION, 'utf8');
/** The guard's own body, not the header that explains it. */
const guard = between(sql, 'create or replace function public.marketplace_order_is_finished_by_its_seller()', 'comment on function');

describe('a marketplace order is returned or completed by its seller, in the database too', () => {
  it('is a BEFORE UPDATE row trigger on marketplace_orders, re-runnable', () => {
    expect(sql).toContain('drop trigger if exists trg_marketplace_orders_finished_by_its_seller on public.marketplace_orders;');
    const create = between(sql, 'create trigger trg_marketplace_orders_finished_by_its_seller', 'do $$\nbegin\n  if not exists (select 1 from pg_trigger');
    expect(create).toContain('before update on public.marketplace_orders');
    expect(create).toContain('for each row execute function public.marketplace_order_is_finished_by_its_seller()');
    // The drop comes before the create, so a second run replaces rather than fails.
    expect(at(sql, 'drop trigger if exists trg_marketplace_orders_finished_by_its_seller'))
      .toBeLessThan(at(sql, 'create trigger trg_marketplace_orders_finished_by_its_seller'));
    // And the migration checks its own wiring: BEFORE, ROW, UPDATE.
    expect(sql).toContain('(t.tgtype & 16) = 16) then -- UPDATE');
  });

  it("guards exactly the app's seller-only steps, and returned_at", () => {
    const statuses = /new\.status in \(([^)]*)\)/.exec(guard)?.[1];
    expect(statuses?.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...SELLER_ONLY_ORDER_STEPS].sort());
    // A change, not a re-statement of the same step.
    expect(guard).toContain('new.status is distinct from old.status and new.status in');
    expect(guard).toContain('or new.returned_at is distinct from old.returned_at then');
    // Every other step stays with either party, in the app and here.
    for (const step of ['confirmed', 'active', 'cancelled']) {
      expect(mayTakeOrderStep('buyer', step), step).toBe(true);
      expect(guard).not.toContain(`'${step}'`);
    }
  });

  it("asks the app's question: is the caller the order's seller member", () => {
    expect(readFileSync(ACTIONS, 'utf8'))
      .toContain('if (SELLER_ONLY_ORDER_STEPS.has(status) && order.seller_member !== ctx.active.member.id) {');
    expect(guard).toContain('if new.seller_member is null');
    expect(guard).toContain('or public.marketplace_member_id(new.family_id) is distinct from new.seller_member then');
    // The seller member, not anyone in the seller's family.
    expect(guard).not.toContain('is_family_member');
    expect(guard).not.toContain('can_manage_family');
    expect(guard).toContain(`raise exception '${SENTENCE}'\n        using errcode = '42501';`);
  });

  it('lets the service role, session-less writers and definer functions through, and only those', () => {
    expect(guard).toContain("if current_user not in ('authenticated', 'anon') then\n    return new;\n  end if;");
    // current_user names the role running the statement only in an invoker:
    // a definer would make it the owner and exempt every caller (0334, 0482).
    expect(guard).toContain("returns trigger\nlanguage plpgsql\nsecurity invoker\nset search_path = ''\nas $$");
    expect(between(guard, 'returns trigger', 'as $$')).not.toMatch(/definer/i);
    expect(sql).toContain('revoke all on function public.marketplace_order_is_finished_by_its_seller() from public, anon, authenticated;');
    expect(sql).toContain("and not f.prosecdef\n                    and exists (select 1 from unnest(f.proconfig) c where c = 'search_path=\"\"')) then");
    // The in-person hand-off is a definer, so its write passes as the owner's.
    const rpc = bodyOf(readFileSync(HANDOFF_RPC, 'utf8'), 'CREATE OR REPLACE FUNCTION public.marketplace_complete_handoff', '$function$;');
    expect(rpc).toContain('SECURITY DEFINER');
    expect(rpc).toContain("set status = 'completed'");
  });

  it('is held, not released, under its number', () => {
    expect(sql).toContain('HELD: 0518');
    expect(sql).toContain('requested on\n-- #771 in comment 6133974146');
    const row = readFileSync(README, 'utf8').split('\n').find((line) => line.startsWith('| `0518_'));
    expect(row).toContain('`0518_a_marketplace_order_is_returned_or_completed_by_its_seller.sql`');
    expect(row).toContain('requested on #771 in comment 6133974146, not yet confirmed');
    expect(row).toContain(WORKFLOW);
  });

  it('is proven by a probe with negative controls, run by its workflow on both sides of the migration', () => {
    const probe = readFileSync(PROBE, 'utf8');
    expect(probe).toContain(`refused   constant text := '42501: ${SENTENCE}';`);
    for (const control of [
      "'the buyer marked their active borrow returned'",
      "'the buyer marked their active sale completed'",
      "'the buyer marked their returned borrow completed'",
      "'the buyer stamped their active borrow returned_at'",
      "'the buyer marked their active borrow with no seller left returned'",
      "'the in-family buyer marked their active sale completed'",
      'CONTROL: the seller could not mark their lent ladder returned',
      "CONTROL: the buyer could not %s their own order",
      'CONTROL: the buyer could not complete the order in person with the hand-off code',
      'CONTROL (service role)',
      'CONTROL (session-less writer, null uid)',
      'MUTATION M1',
      'MUTATION M2',
      'NEGATIVE CONTROL',
    ]) expect(probe, control).toContain(control);

    const workflow = readFileSync(WORKFLOW, 'utf8');
    // The defect is shown on the released schema BEFORE the held file is applied.
    expect(at(workflow, '- name: The released schema still lets a buyer finish an order themselves'))
      .toBeLessThan(at(workflow, '- name: Apply the held migration, twice'));
    expect(at(workflow, '- name: Apply the held migration, twice'))
      .toBeLessThan(at(workflow, '- name: A marketplace order is returned or completed by its seller'));
    expect(workflow).toContain('run: bash docs/audit/pg-bootstrap.sh');
    expect(workflow).toContain(`psql -X -v ON_ERROR_STOP=1 -q -f ${MIGRATION}\n          psql -X -v ON_ERROR_STOP=1 -q -f ${MIGRATION}`);
    expect(workflow).toContain("grep -qF 'a-marketplace-order-is-returned-or-completed-by-its-seller: OK'");
    // Each failure the workflow expects before the migration is one the probe can report.
    for (const [, line] of workflow.matchAll(/^ {12}"(the (?:in-family )?buyer [^"]+) \(OK 1\)"/gm)) {
      expect(probe, line).toContain(`'${line}'`);
    }
    expect([...workflow.matchAll(/^ {12}"(the (?:in-family )?buyer [^"]+) \(OK 1\)"/gm)]).toHaveLength(6);
  });

  it('keeps the released probe that had the buyer return an order passing under both rules', () => {
    const released = readFileSync(RELEASED_PROBE, 'utf8');
    const branch = between(released, "if to_regprocedure('public.marketplace_order_is_finished_by_its_seller()') is null then", "raise exception '0409: a party could not advance their own order");
    expect(branch).toContain(`refused := sqlerrm = '${SENTENCE}';`);
    expect(branch).toContain("perform set_config('request.jwt.claim.sub', ua::text, true);");
  });
});
