import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// AUTHZ-005. Guardian's routing rules were manager-only, but the tables that
// decide who rings through — contacts' trust levels, each member's screening
// profile, and the suggestions a parent approves — were writable by any family
// member. Reproduced as a child on the local stack before the repair, seven
// findings, among them: a blocked caller raised to immediate_family, a child
// switching off their own screening, and a parent's manager-only routing rule
// deleted through `condition_contact_id … ON DELETE CASCADE` by deleting the
// contact it names. docs/audit/guardian-authority-check.sql holds it on every
// PR; this file pins the parts that could shrink quietly.

// Three of the four tables were closed on main first — 0318 and 0345 rebuilt
// the write policies on guardian_contacts, guardian_member_profiles and
// guardian_suggestions as manager writes — so this branch's migration carries
// only guardian_communications, the one they left open.
const migration = readFileSync('supabase/migrations/0398_guardian_screening_is_the_parents_decision.sql', 'utf8');
const trustAndRouting = readFileSync('supabase/migrations/0345_guardian_trust_and_routing_are_manager_writes.sql', 'utf8');
const probe = readFileSync('docs/audit/guardian-authority-check.sql', 'utf8');
const actions = readFileSync('app/(app)/guardian/actions.ts', 'utf8');

describe('Guardian screening is the parents\' decision (AUTHZ-005)', () => {
  it('guards all four tables\' writes, and leaves reading alone', () => {
    expect(trustAndRouting).toContain("array['guardian_contacts', 'guardian_member_profiles', 'guardian_suggestions']");
    expect(trustAndRouting).toMatch(/for delete to authenticated using \(public\.can_manage_family\(family_id\)\)/);
    expect(migration).toMatch(/on public\.guardian_communications\s+as restrictive for insert to authenticated with check \(public\.can_manage_family\(family_id\)\)/);
    expect(migration).toMatch(/on public\.guardian_communications\s+as restrictive for delete to authenticated using \(public\.can_manage_family\(family_id\)\)/);
    expect(migration).toContain('if n <> 3 then');
    expect(migration).not.toMatch(/for select/i);
  });

  it('the probe covers every breach it was written from, including the cascade', () => {
    for (const phrase of [
      'BREACH: a child raised a blocked caller to immediate_family',
      'BREACH: a child switched off their own call screening',
      "BREACH: a child deleted a parent''s manager-only routing rule by deleting the contact it names (cascade)",
      'BREACH: a child rewrote a pending suggestion before a parent approved it',
      'BREACH: a child fabricated a call record',
      "CONTROL FAILED: the child cannot see the family''s contacts",
      'CONTROL FAILED: the parent could not approve the suggestion',
    ]) {
      expect(probe, phrase).toContain(phrase);
    }
  });

  it('every product writer of these tables is parent-gated, so managers-only takes nothing away', () => {
    // Each exported action that writes a guarded Guardian table must refuse a
    // non-manager before it gets there.
    const bodies = actions.split(/\nexport async function /).slice(1);
    const writers = bodies.filter((b) => /\.from\('guardian_(contacts|member_profiles|suggestions)'\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/.test(b));
    expect(writers.length).toBeGreaterThanOrEqual(5);
    for (const body of writers) {
      const name = body.slice(0, body.indexOf('('));
      expect(body, name).toMatch(/if \(!isManager\(ctx\.active\.role\)\) return guardianForbidden\(\);/);
    }
  });
});
