import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// An RSVP is a statement about a person, so only that person — or a parent
// acting for them — may make it.
//
// 0047 shipped `event_rsvps` with ONE policy for every verb, gated on
// `is_family_member(family_id)` and nothing else. No member predicate on either
// side, so any member of the household could INSERT an 'accepted' row carrying
// a parent's member_id, UPDATE a sibling's reply, or DELETE one. And because
// `event_rsvps_once UNIQUE (event_id, member_id)` makes the write an upsert, a
// second answer did not sit alongside the first: it REPLACED it, silently.
//
// Nothing in the product does that — the event modal writes only `selfMemberId`
// and `rsvpToEvent` takes `member_id` from `scope.memberId` (pinned in
// tests/service-notes-goals-rsvp.test.ts) — but that app-level care was the ONLY
// thing standing between a child and a reply in a parent's name. 0272 puts the
// rule where the next writer cannot forget it.
//
// Proven against real Postgres before shipping (PGlite, migration applied
// verbatim, acting as parent/teen/child under `set role authenticated`):
// teen answers for themselves ALLOW; teen answers for the parent DENY (RLS
// error); child answers for a sibling DENY; child answers for themselves ALLOW;
// parent answers for the child ALLOW; teen overwrites or deletes the parent's
// reply DENY (0 rows — a failing USING clause filters rather than raises);
// parent corrects their own reply ALLOW; child sees who is coming ALLOW.
//
// CI has no Postgres, so what this file guards is the policy SHAPE that made
// those outcomes true, including the two ways the fix could be quietly undone.
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_rsvp_is_first_person.sql'));
  expect(files.length, 'rsvp_is_first_person migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

const FIRST_PERSON = 'public.is_self_member(member_id) or public.can_manage_family(family_id)';

describe('0272 an RSVP is first-person', () => {
  const sql = migration();

  it('drops 0047’s FOR ALL policy, which would otherwise defeat every rule below', () => {
    // Permissive policies are OR'd. Leaving "Members can manage event_rsvps" in
    // place would make the four narrower policies decorative — the single most
    // likely way for this migration to look right and do nothing.
    expect(sql).toContain('drop policy if exists "Members can manage event_rsvps" on public.event_rsvps');
    expect(sql).not.toMatch(/create policy[^;]*for all[^;]*event_rsvps/is);
  });

  for (const verb of ['insert', 'update', 'delete'] as const) {
    it(`${verb} requires the row to be yours, or you to be a manager`, () => {
      const policy = sql.slice(sql.indexOf(`create policy event_rsvps_${verb}`));
      const body = policy.slice(0, policy.indexOf(';') + 1);
      expect(body, `event_rsvps_${verb} is missing the first-person predicate`).toContain(FIRST_PERSON);
      expect(body).toContain('public.is_family_member(family_id)');
    });
  }

  it('checks the UPDATE on the way in as well as on the way out', () => {
    // USING alone decides which rows you may touch; without WITH CHECK you could
    // take your own reply and re-point its member_id at a parent — answering for
    // them by moving a row you were entitled to edit.
    const policy = sql.slice(sql.indexOf('create policy event_rsvps_update'));
    const body = policy.slice(0, policy.indexOf(';') + 1);
    expect(body.match(new RegExp(FIRST_PERSON.replace(/[().]/g, '\\$&'), 'g'))?.length,
      'event_rsvps_update needs the predicate in BOTH using and with check').toBe(2);
    expect(body).toMatch(/using \([\s\S]*with check \(/);
  });

  it('keeps a manager able to write anyone’s row, which is what lets an approval replay', () => {
    // `performApproved` runs under the APPROVING parent's client while writing
    // the ASKER's member_id (lib/services/approvals: scopeForApprovedWork). Drop
    // the manager branch and this migration breaks the very path it protects.
    expect(sql).toContain('public.can_manage_family(family_id)');
  });

  it('leaves SELECT open to the family — seeing who is coming is the point', () => {
    const policy = sql.slice(sql.indexOf('create policy event_rsvps_select'));
    const body = policy.slice(0, policy.indexOf(';') + 1);
    expect(body).toContain('using (public.is_family_member(family_id))');
    expect(body).not.toContain('is_self_member');
  });

  it('resolves "is this me" through the roster, not through a client-supplied id', () => {
    expect(sql).toMatch(/create or replace function public\.is_self_member\(p_member_id uuid\)[\s\S]*?security definer/);
    expect(sql).toMatch(/where id = p_member_id and user_id = auth\.uid\(\) and is_active/);
  });

  it('touches only event_rsvps — notes and goals are a product decision, not this fix', () => {
    // They carry the same `is_family_member`-only shape and are recorded in the
    // gap ledger. A shared family notepad being collaboratively editable is
    // plausibly the intent, so tightening it silently here would be a product
    // change wearing a security fix's clothes.
    expect(sql).not.toMatch(/(create policy|alter table|drop policy)[^;]*\bpublic\.(notes|goals)\b/i);
  });
});
