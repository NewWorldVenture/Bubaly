import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A calendar event names the person who made it, or nobody.
//
// 01050 is the whole of `calendar_events`' policy set and every verb of it is
// the same sentence, `public.is_family_member(family_id)` — role-blind AND
// identity-blind. So a CHILD could insert an event carrying a PARENT's uid in
// `created_by` (measured on a replayed database), and could rewrite or erase an
// existing row's author afterwards. `/dashboard/workload` reads that column and
// scores each organized event as 12 minutes of "invisible labour", so the
// forgery moves a real number on a real screen.
//
// 0339 closes the INSERT half. What this file guards is the policy SHAPE, since
// CI has no Postgres — and specifically the three ways the fix could be quietly
// undone, each of which breaks a DIFFERENT legitimate writer.
//
// Measured against a real Postgres 16 before shipping (all 349 prior migrations
// replayed via docs/audit/pg-bootstrap.sh, then 0339 applied, acting under
// `set role authenticated` with `request.jwt.claim.sub` set): child names the
// parent DENY; child names themselves ALLOW; child sends no created_by ALLOW;
// insert-NULL-then-UPDATE-to-parent FROZEN; child rewrites an existing author
// FROZEN; child erases an author FROZEN; `ON CONFLICT DO UPDATE` FROZEN; child
// edits a parent's event content ALLOW; manager names another member ALLOW;
// `delete from auth.users` still NULLs created_by with zero dangling rows.
// The standing proof is docs/audit/a-calendar-event-names-who-made-it-check.sql.
function migration(): string {
  const dir = 'supabase/migrations';
  const file = readdirSync(dir).find((f) => /^0339_.*calendar_event/.test(f));
  if (!file) throw new Error('0339 calendar attribution migration is missing from supabase/migrations');
  return readFileSync(`${dir}/${file}`, 'utf8');
}

const sql = migration();

describe('a calendar event names who actually made it (0339)', () => {
  it('guards INSERT with a RESTRICTIVE policy that ANDs with 01050 rather than replacing it', () => {
    // Restating 01050's policy here would leave that repair describing a dead
    // policy and re-open the drift it was written to fix.
    expect(sql).toMatch(/create policy calendar_events_author_guard[\s\S]*?as restrictive for insert to authenticated/);
    // NOT `for all`, NOT PUBLIC: docs/audit/family-self-read-check.sql detects a
    // deliberate deny-all quarantine as (restrictive, cmd '*', roles {0}). This
    // policy written that way would make calendar_events be misread as
    // quarantined and INVERT that probe's invariant.
    expect(sql).not.toMatch(/calendar_events_author_guard[\s\S]*?as restrictive for all/);
  });

  it('admits a NULL author, because ICS import and feed sync send none', () => {
    // app/api/calendar/sync/route.ts:132 and lib/server/calendar-feeds.ts:54
    // both insert rows with no `created_by` key through the caller's OWN
    // cookie-bound client, so RLS applies. Refusing NULL breaks calendar import
    // for every user — and the feed cron runs service-role and would have
    // survived, making the breakage look intermittent rather than total.
    expect(sql).toContain('created_by is null');
  });

  it('admits the caller’s own id', () => {
    expect(sql).toContain('created_by = auth.uid()');
  });

  it('keeps a manager able to name anyone, which is what lets an approval replay', () => {
    // `performApproved`'s `case 'tool':` builds its scope from
    // scopeForApprovedWork, which rewrites userId to the ASKER's while
    // scope.db stays the APPROVER's cookie-bound session;
    // `calendar.createEvent` is a registered tool, so lib/services/calendar
    // writes the asker's uid through the approver's client. Drop the manager
    // branch and this migration breaks the very path it protects — which is
    // exactly what got the earlier 0339/0340/0342 drafts rejected.
    expect(sql).toContain('public.can_manage_family(family_id)');
    // And it must NOT be a bare identity pin.
    expect(sql).not.toMatch(/with check \(\s*created_by = auth\.uid\(\)\s*\)/);
  });

  it('freezes the author on UPDATE with a trigger, not a checking policy', () => {
    // No writer sends created_by on UPDATE, so a policy's WITH CHECK would
    // evaluate the row's EXISTING author and refuse a member legitimately
    // editing an event somebody else created — which 01050 allows on purpose.
    // Without the freeze the INSERT guard is defeated in two statements, and by
    // ON CONFLICT DO UPDATE, which an INSERT WITH CHECK never sees.
    expect(sql).toMatch(/create trigger calendar_events_attribution_immutable\s+before update on public\.calendar_events/);
    expect(sql).toContain('new.created_by := old.created_by');
  });

  it('does not touch attribution_is_immutable(), which 0338 owns', () => {
    // 0338's function assigns `new.logged_by := old.logged_by` unconditionally
    // and calendar_events has no logged_by column. Replacing it in place would
    // hold only while that replacement stayed the last word — and
    // docs/PENDING_PROD_MIGRATIONS.md records applying as manual and piecemeal,
    // so a later re-run of 0338 would abort EVERY UPDATE of calendar_events.
    expect(sql).not.toMatch(/create or replace function public\.attribution_is_immutable/);
    expect(sql).toContain('create or replace function public.calendar_attribution_is_immutable()');
  });

  it('guards the preserve on pg_trigger_depth so ON DELETE SET NULL still fires', () => {
    // MEASURED: `created_by` is `references auth.users(id) on delete set null`
    // (0002_tables.sql:99). That referential action is itself an UPDATE, so an
    // UNCONDITIONAL preserve reverts it. In autocommit — which is what
    // `admin.auth.admin.deleteUser` issues — the delete then reports success and
    // leaves a DANGLING reference; inside a transaction it raises 23503 and
    // blocks account deletion outright. Both measured on the real table.
    expect(sql).toContain('pg_trigger_depth() = 1');
  });

  it('revokes the write verbs from anon and leaves SELECT alone', () => {
    expect(sql).toContain('revoke insert, update, delete, truncate on public.calendar_events from anon');
    expect(sql).not.toMatch(/revoke[^;]*select[^;]*on public\.calendar_events from anon/);
  });

  it('states the residue instead of implying the finding is fully closed', () => {
    // AUTHZ-021 is closed on INSERT only. A manager may still name any member;
    // any member may still insert unattributed; a child may still SEIZE a
    // parent's row and rewrite its content under a now-frozen author; DELETE is
    // untouched. A header that claimed otherwise is the failure mode that got
    // the earlier draft rejected.
    expect(sql).toContain('PARENT-TO-CHILD FORGERY IS NOT CLOSED');
    expect(sql).toContain('SEIZE-AND-REWRITE IS NOT CLOSED');
    expect(sql).toContain('DELETE IS UNCHANGED');
  });
});
