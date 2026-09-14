import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { resolveFamilyByEmailLocalResult } from '../lib/contact-center/server';

// `local` is parsed from the inbound message's `To` header — supplied by the
// sender, not merely guessable. `_` is BOTH a legal local-part character
// (LOCAL_RE in lib/contact-center/address.ts permits it) and LIKE's
// single-character wildcard, so an unescaped pattern routes mail addressed to
// `smit_@bubaly.com` into the family that owns `smith`: their Contact Center
// inbox, their AI concierge, possibly their urgent-SMS escalation, and an
// auto-reply from their own identity confirming the match.
//
// Verified in PostgreSQL 16, not reasoned about:
//   'smith'  ilike 'smit_'   -> t      'smith'  ilike 'smit\_'  -> f
//   'smith'  ilike 's%'      -> t      'smit_h' ilike 'smit\_h' -> t
//
// The last one is why this escapes rather than switching to .eq: a real
// underscore must keep routing, and .eq would also drop case-insensitivity
// while the unique index is on lower(email_local).

function captureIlikePattern() {
  const seen: { column: string; pattern: string }[] = [];
  const admin = {
    from: () => ({
      select: () => ({
        ilike: (column: string, pattern: string) => {
          seen.push({ column, pattern });
          return { maybeSingle: async () => ({ data: null, error: null }) };
        },
      }),
    }),
  };
  return { admin, seen };
}

describe('inbound email routing cannot be wildcarded into another family', () => {
  it('escapes the single-character wildcard', async () => {
    const { admin, seen } = captureIlikePattern();
    await resolveFamilyByEmailLocalResult(admin as never, 'smit_');
    expect(seen[0].pattern).toBe('smit\\_');
    expect(seen[0].pattern).not.toBe('smit_');
  });

  it('escapes the many-character wildcard', async () => {
    const { admin, seen } = captureIlikePattern();
    await resolveFamilyByEmailLocalResult(admin as never, 's%');
    expect(seen[0].pattern).toBe('s\\%');
  });

  it('escapes every wildcard, not just the first', async () => {
    const { admin, seen } = captureIlikePattern();
    await resolveFamilyByEmailLocalResult(admin as never, '_a%b_');
    expect(seen[0].pattern).toBe('\\_a\\%b\\_');
  });

  it('leaves an ordinary local-part untouched', async () => {
    const { admin, seen } = captureIlikePattern();
    await resolveFamilyByEmailLocalResult(admin as never, 'the-smiths.family');
    expect(seen[0].pattern).toBe('the-smiths.family');
  });

  it('still routes an address that legitimately contains an underscore', async () => {
    // Escaping must not break real addresses: 'smit_h' ilike 'smit\_h' is TRUE.
    const { admin, seen } = captureIlikePattern();
    await resolveFamilyByEmailLocalResult(admin as never, 'smit_h');
    expect(seen[0].pattern).toBe('smit\\_h');
  });

  it('the source still escapes rather than having been reverted to a raw pattern', () => {
    const src = readFileSync('lib/contact-center/server.ts', 'utf8');
    expect(src).toMatch(/\.ilike\('email_local',\s*escapeLike\(local\)\)/);
    expect(src).not.toMatch(/\.ilike\('email_local',\s*local\)/);
  });
});
