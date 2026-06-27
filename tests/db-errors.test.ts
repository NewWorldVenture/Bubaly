import { describe, it, expect } from 'vitest';
import { describeDbError, isMissingRelationError } from '@/lib/supabase/errors';

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

  it('falls back to the raw message when unclassified', () => {
    expect(describeDbError({ message: 'weird specific thing' })).toBe('weird specific thing');
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
