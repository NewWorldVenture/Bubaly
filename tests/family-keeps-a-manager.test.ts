import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// can_manage_family() is the USING and WITH CHECK clause of fm_update, fm_insert
// and fm_delete (0004_rls.sql), and it is true only for an ACTIVE parent/adult.
// So a family whose last one is demoted, deactivated or removed cannot promote,
// add or reactivate anybody — locked out, with no unwind from inside the
// product. Two clicks reached it: the Family screen rendered Edit/Remove for
// every member including the signed-in one, and its role select offers 'child'.
//
// The behavioural proof lives in docs/audit/family-keeps-a-manager-check.sql
// (A-20), which runs against a real database in CI and covers the two ways this
// fix could have been wrong — blocking an ordinary member's removal, or blocking
// a family deletion cascade. These cases hold the pieces that probe cannot see:
// that the migration is present, and that the screen stops offering the action.

const migration = readFileSync('supabase/migrations/0299_family_keeps_a_manager.sql', 'utf8');
const familyModule = readFileSync('components/modules/family-module.tsx', 'utf8');
const probe = readFileSync('docs/audit/family-keeps-a-manager-check.sql', 'utf8');

describe('a family always keeps someone who can manage it', () => {
  it('guards the invariant in the database, not only on the screen', () => {
    // These are direct browser PostgREST writes: anything holding a JWT can
    // issue them whatever the screen renders, so the UI cannot be the guard.
    expect(migration).toMatch(/create constraint trigger trg_family_keeps_a_manager/);
    expect(migration).toMatch(/after insert or update or delete on public\.family_members/);
  });

  it('defers to commit, so it judges the end state and not each row on the way', () => {
    // A per-row BEFORE trigger refuses legitimate transactions that pass THROUGH
    // a bad intermediate state: tearing a family down deletes its sole parent
    // while a child row is still present, and swapping managers demotes one
    // before or after promoting the other. The first version of this migration
    // was per-row and broke two existing boundary probes on exactly that.
    expect(migration).toMatch(/deferrable initially deferred/);
  });

  it('treats a family with no active members as no violation', () => {
    // Nobody to lock out. Without this, removing every member at once fails.
    expect(migration).toMatch(/if v_members = 0 then/);
  });

  it('lets a family deletion cascade through its last manager', () => {
    // The likeliest way to get this fix wrong: "close my account" becomes a
    // permanent error, because the last manager's row is always in the cascade.
    expect(migration).toMatch(/if not exists \(select 1 from public\.families where id = v_family\)/);
  });

  it('raises check_violation so callers can tell it apart from a refusal', () => {
    expect(migration).toMatch(/errcode = 'check_violation'/);
  });

  it('asserts its own installation rather than trusting the apply', () => {
    expect(migration).toMatch(/did not install trg_family_keeps_a_manager/);
    // and that it is installed DEFERRED, not merely installed
    expect(migration).toMatch(/tgdeferrable/);
    expect(migration).toMatch(/tginitdeferred/);
  });

  it('stops the screen offering an action the database will reject', () => {
    expect(familyModule).toMatch(/const managerCount = activeMembers\.filter/);
    expect(familyModule).toMatch(/const isLastManager =/);
    expect(familyModule).toMatch(/\{canManage && !isLastManager\(m\) && \(/);
  });

  it('has a behavioural probe that CI runs', () => {
    // *-check.sql is the glob docs/audit/run-probes.sh executes.
    expect(probe).toMatch(/A-20 FAIL: the sole manager demoted themselves/);
    expect(probe).toMatch(/A-20 FAIL: the sole manager was deleted/);
    expect(probe).toMatch(/removing a non-manager is unaffected/);
    expect(probe).toMatch(/deleting a family still cascades/);
    expect(probe).toMatch(/removing every member at once is allowed/);
  });
});
