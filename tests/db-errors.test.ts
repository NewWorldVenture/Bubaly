import { describe, it, expect } from 'vitest';
import { describeActionError, describeDbError, isMissingRelationError } from '@/lib/supabase/errors';

describe('describeDbError', () => {
  it('returns a fallback for nullish input', () => {
    expect(describeDbError(null)).toMatch(/something went wrong/i);
    expect(describeDbError(undefined, 'custom')).toBe('custom');
  });

  it('classifies RLS / permission errors', () => {
    expect(describeDbError({ code: '42501', message: 'permission denied for table' })).toMatch(/permission/i);
    expect(describeDbError({ message: 'new row violates row-level security policy' })).toMatch(/permission/i);
  });

  it('classifies unique-violation conflicts', () => {
    expect(describeDbError({ code: '23505', message: 'duplicate key value' })).toMatch(/already exists/i);
  });

  it('classifies missing rows / not found', () => {
    expect(describeDbError({ code: 'PGRST116', message: 'no rows' })).toMatch(/could not be found/i);
    expect(describeDbError({ code: '23503', message: 'foreign key' })).toMatch(/could not be found/i);
  });

  it('classifies missing required fields', () => {
    expect(describeDbError({ code: '23502', message: 'null value in column' })).toMatch(/required information/i);
  });

  it('classifies network/transport failures', () => {
    expect(describeDbError({ message: 'Failed to fetch' })).toMatch(/network/i);
    expect(describeDbError(new Error('NetworkError when attempting to fetch resource'))).toMatch(/network/i);
  });

  // An error the APPLICATION threw has no Postgres code, and its message was
  // written for a person. That is still the best thing to show.
  it('keeps the message of an unclassified error the app threw itself', () => {
    expect(describeDbError({ message: 'weird specific thing' })).toBe('weird specific thing');
    expect(describeDbError(new Error('Pick a date first'))).toBe('Pick a date first');
  });

  // …and an unclassified error that CARRIES a code came from the database, where
  // the message was written for whoever maintains the schema.
  //
  // The ten shapes classified above are not the only shapes there are. Each of
  // these is a real string Postgres returns, and each hands out a piece of the
  // schema to anyone who can make a query fail — the enum one gives away the
  // type's whole grammar from a single bad write. On the AI paths it travels
  // further than the browser: lib/ai/tools/* put this string into fail(), which
  // reaches the model's context too.
  it('does not hand out the schema when the database is the one talking', () => {
    const leaks: [string, string][] = [
      ['22P02', 'invalid input value for enum redemption_status: "bogus"'],
      ['22003', 'value "99999999999" is out of range for type integer'],
      ['42883', 'function public.award_allowance(uuid, bigint) does not exist'],
      ['42P01', 'relation "public.wallet_ledger_private" does not exist'],
      ['P0001', 'family_entitlement_is_not_self_written: trial_ends_at'],
    ];
    for (const [code, message] of leaks) {
      const described = describeDbError({ code, message }, 'Could not save that.');
      expect(described, `${code} leaked its raw message`).toBe('Could not save that.');
      expect(described).not.toContain('redemption_status');
      expect(described).not.toContain('wallet_ledger_private');
      expect(described).not.toContain('award_allowance');
    }
  });

  it('still classifies a coded error it recognises, rather than blanking it', () => {
    // The fallback is for the UNRECOGNISED coded error. A code with a branch
    // above must still produce its own written sentence, or this change would
    // have traded a leak for a product that can no longer explain itself.
    expect(describeDbError({ code: '42501', message: 'x' }, 'fb')).toMatch(/permission/i);
    expect(describeDbError({ code: '23505', message: 'x' }, 'fb')).toMatch(/already exists/i);
    expect(describeDbError({ code: 'PGRST116', message: 'x' }, 'fb')).toMatch(/could not be found/i);
    expect(describeDbError({ code: '23514', message: 'x' }, 'fb')).toMatch(/required information/i);
  });

  it('handles thrown strings', () => {
    expect(describeDbError('boom', 'fb')).toBe('boom');
  });
});

describe('isMissingRelationError', () => {
  it('detects PostgREST schema-cache misses', () => {
    expect(isMissingRelationError({ code: 'PGRST205', message: "Could not find the table 'public.family_communications' in the schema cache" })).toBe(true);
    expect(isMissingRelationError({ message: "Could not find the table 'public.x' in the schema cache" })).toBe(true);
    expect(isMissingRelationError({ code: 'PGRST204', message: 'column not found' })).toBe(true);
  });

  it('detects Postgres undefined_table / undefined_column codes', () => {
    expect(isMissingRelationError({ code: '42P01', message: 'relation "foo" does not exist' })).toBe(true);
    expect(isMissingRelationError({ code: '42703', message: 'column "bar" does not exist' })).toBe(true);
  });

  it('is false for ordinary errors and nullish input', () => {
    expect(isMissingRelationError(null)).toBe(false);
    expect(isMissingRelationError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingRelationError({ message: 'duplicate key value' })).toBe(false);
  });
});

describe('describeActionError', () => {
  it('keeps actionable categories while hiding unclassified details', () => {
    expect(describeActionError({ code: '42501', message: 'permission denied for table secrets' })).toMatch(/permission/i);
    expect(describeActionError({ message: 'relation private_table does not exist' }, 'Could not save.')).toBe('Could not save.');
    expect(describeActionError(new Error('provider token abc123 leaked'), 'Could not save.')).toBe('Could not save.');
  });
});
