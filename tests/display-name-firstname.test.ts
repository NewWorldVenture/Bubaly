import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { firstName } from '@/lib/utils/format';

// PLA-0780: family_members.display_name is NULLABLE in the DB but typed as
// `string`, so a raw `member.display_name.split(' ')[0]` throws during render
// for a member with a null name — which white-screened the Kitchen Display (the
// "Reconnecting…" loop, root-caused in e92fd897) and lurked in ~20 other UI
// sites. Every UI site must go through the null-safe firstName() helper.
describe('firstName helper', () => {
  it('returns "Member" for null/undefined/blank names (never throws)', () => {
    expect(firstName(null)).toBe('Member');
    expect(firstName(undefined)).toBe('Member');
    expect(firstName('')).toBe('Member');
    expect(firstName('   ')).toBe('Member');
  });

  it('returns the first whitespace-delimited token for real names', () => {
    expect(firstName('Alice Smith')).toBe('Alice');
    expect(firstName('Bob')).toBe('Bob');
    expect(firstName('  Carol   Anne  Jones ')).toBe('Carol');
  });
});

describe('no raw display_name.split in UI source (crash guard)', () => {
  it('has zero unguarded display_name.split() sites in app/ or components/ .tsx', () => {
    // API .ts routes already guard with `if (m?.display_name)`, so scope the
    // guard to rendered UI (.tsx) where a null throw white-screens the page.
    let out = '';
    try {
      out = execSync(
        "grep -rn 'display_name\\.split' app components --include='*.tsx' || true",
        { encoding: 'utf8' },
      ).trim();
    } catch {
      out = '';
    }
    expect(out, `raw display_name.split() found — use firstName():\n${out}`).toBe('');
  });
});
