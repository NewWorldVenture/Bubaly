import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C1-S6-06.
 *
 * `household_info` carries `is_sensitive`, and the UI honours it —
 * binder-module masks such a value behind an eye toggle labelled "Mask by
 * default". The mask was the only thing honouring it: the policy was one
 * `FOR ALL USING is_family_member(family_id)`, so the raw row reached every
 * member through the browser's anon client. Measured on a replayed schema, a
 * child read `hunter2-alarm-4417` in the clear.
 *
 * This is 0266's shape — that migration moved the document vault's sensitivity
 * predicate into the database for the same reason, in its own words: the
 * modules "query through the browser anon client and never reach" the service
 * that filtered correctly.
 */
const sql = readFileSync('supabase/migrations/0305_household_secrets_are_not_child_readable.sql', 'utf8')
  .replace(/--[^\n]*/g, '');

describe('the binder’s sensitive flag is enforced where it cannot be bypassed', () => {
  it('replaces the blanket policy rather than adding beside it', () => {
    // Leaving "Members manage household_info" in place would make the new
    // policies useless: PostgreSQL ORs permissive policies together.
    expect(sql).toContain('drop policy if exists "Members manage household_info" on public.household_info;');
    expect(at(sql, 'drop policy if exists "Members manage household_info"'))
      .toBeLessThan(at(sql, 'create policy household_info_select'));
  });

  it('gates every verb on the same predicate', () => {
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(sql, verb).toContain(`create policy household_info_${verb} on public.household_info`);
    }
    const predicate = /not is_sensitive or public\.can_manage_family\(family_id\)/g;
    // select + insert + delete once each, update twice (using AND with check).
    expect(sql.match(predicate) ?? []).toHaveLength(5);
  });

  it('keeps both halves of the update, so the flag cannot be cleared to read the value', () => {
    const update = sql.slice(at(sql, 'create policy household_info_update'), at(sql, 'create policy household_info_delete'));
    expect(update).toContain('using (');
    expect(update).toContain('with check (');
  });

  it('leaves an ordinary binder row alone', () => {
    // `not is_sensitive` short-circuits to is_family_member for everything the
    // family did not mark — the bin day stays readable by the children.
    expect(sql).toContain('public.is_family_member(family_id)');
    expect(sql).not.toContain('can_manage_family(family_id))\n  );\n\ndrop policy if exists household_info_select');
  });

  it('the boundary probe CI replays exists and seeds a row before asserting zero', () => {
    const probe = readFileSync('docs/audit/household-binder-boundary-check.sql', 'utf8');
    // An assertion that a child reads zero rows passes against an empty table
    // whatever the policy says.
    expect(at(probe, "insert into public.household_info")).toBeLessThan(at(probe, 'a child reads % sensitive binder row(s)'));
    expect(probe).toContain('impersonation failed');
    expect(probe).toContain('the fix went too far');
  });

  it('0266, the precedent it copies, is still there to copy', () => {
    const doc = readFileSync('supabase/migrations/0266_document_vault_boundary.sql', 'utf8');
    expect(doc).toContain('not public.is_sensitive_document(is_secure, category) or public.can_manage_family(family_id)');
  });
});
