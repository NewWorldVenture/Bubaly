// Choosing a family's @bubaly.com local-part automatically.
//
// Split deliberately: the CANDIDATE ORDER is pure and unit-tested here, and the
// database only ever answers "is this one free?". Collision handling is the
// whole difficulty — "smith" is taken by the second Smith family who signs up —
// and it would otherwise only be exercisable against a live unique index.

import { normalizeEmailLocal, isClaimableEmailLocal, suggestEmailLocal } from './address';

/** How many names to offer before giving up and leaving the family unassigned. */
export const MAX_CANDIDATES = 12;

/**
 * The local-parts to try, in order, for a family.
 *
 * The first is the readable one a person would choose themselves ("smith").
 * Later ones stay readable as long as possible — smith2, smith3 — because a
 * family reads this address aloud to a school secretary. Only once the obvious
 * names are gone does it fall back to a short random-looking suffix, which
 * always terminates and never collides in practice.
 *
 * `seed` makes the random tail deterministic for tests; callers pass nothing.
 */
export function candidateLocals(familyName: string | null | undefined, seed = ''): string[] {
  const base = suggestEmailLocal(familyName);
  const out: string[] = [];
  const add = (value: string) => {
    const local = normalizeEmailLocal(value);
    // Every candidate must be claimable, not merely well-formed: the suffixing
    // below could otherwise walk a name back into the reserved namespace.
    if (isClaimableEmailLocal(local) && !out.includes(local)) out.push(local);
  };

  add(base);
  for (let n = 2; n <= 6 && out.length < MAX_CANDIDATES; n++) add(`${base}${n}`);
  // A readable household suffix before falling back to noise.
  add(`${base}-family`);
  add(`${base}-home`);
  // Deterministic tail: derived from the name plus the seed, so a retry of the
  // same family proposes the same list and cannot drift.
  const tail = hash36(`${base}:${seed}`);
  for (let i = 0; out.length < MAX_CANDIDATES && i < 6; i++) {
    add(`${base}-${tail.slice(i, i + 4) || tail}`);
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** Small, stable, non-cryptographic base36 hash — only needs to be spread out. */
function hash36(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').repeat(2);
}

// ── Server side ─────────────────────────────────────────────────────────────
// Kept in this file rather than contact-center/server.ts so the pure half above
// stays importable from a test without dragging a Supabase client in.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type ProvisionResult =
  | { assigned: true; local: string }
  | { assigned: false; reason: 'already_assigned' | 'exhausted' | 'unavailable'; local?: string };

/**
 * Give a family its address, best effort.
 *
 * NEVER throws and never reports failure as an error the caller must handle:
 * an address is a bonus on top of a family that already exists, so a contended
 * name or an unreachable table must not fail the onboarding that triggered it.
 * The family simply has no address yet and can claim one later in the Contact
 * Center — the same screen that has always been there.
 *
 * Races are resolved by the unique index on lower(email_local), not by checking
 * first: two families finishing onboarding at the same instant both see "smith"
 * free, and exactly one of the inserts wins. A 23505 is therefore an ordinary
 * outcome here, not an error — it means "try the next name".
 */
export async function provisionFamilyEmailLocal(
  admin: SupabaseClient<Database>,
  familyId: string,
  familyName: string | null | undefined,
): Promise<ProvisionResult> {
  try {
    const existing = await admin
      .from('family_contact_channels')
      .select('email_local')
      .eq('family_id', familyId)
      .maybeSingle();
    if (existing.error) return { assigned: false, reason: 'unavailable' };
    // Idempotent: a retried onboarding must not rename a family's address.
    if (existing.data?.email_local) return { assigned: false, reason: 'already_assigned', local: existing.data.email_local };

    for (const local of candidateLocals(familyName, familyId)) {
      const { error } = await admin
        .from('family_contact_channels')
        .update({ email_local: local })
        .eq('family_id', familyId)
        .is('email_local', null);
      if (!error) {
        // The update reports no error when it matched nothing either, so
        // confirm what actually landed rather than assuming this candidate won.
        const check = await admin
          .from('family_contact_channels')
          .select('email_local')
          .eq('family_id', familyId)
          .maybeSingle();
        if (check.data?.email_local) return { assigned: true, local: check.data.email_local };
        continue;
      }
      if (error.code === '23505') continue; // taken — next candidate
      return { assigned: false, reason: 'unavailable' };
    }
    return { assigned: false, reason: 'exhausted' };
  } catch {
    return { assigned: false, reason: 'unavailable' };
  }
}
