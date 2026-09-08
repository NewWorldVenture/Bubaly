import { describe, expect, it } from 'vitest';
import {
  describeReadError,
  isCredentialError,
  credentialHint,
  SERVICE_ROLE_KEY_HINT,
} from '../lib/supabase/settle';

// The production bug this file exists for: /admin listed four failed reads with
// nothing after the colon — "families (count): " — because a count read is sent
// as HEAD, PostgREST returns no body on a HEAD, and supabase-js therefore hands
// back an error whose message is the EMPTY STRING. `?? 'unknown error'` does not
// fire on '', so the reason silently vanished from exactly the rows that needed it.
describe('describeReadError', () => {
  it('never returns a blank reason for the empty message a HEAD count produces', () => {
    const headCountError = { message: '', code: '', details: null, hint: null };
    expect(describeReadError(headCountError)).toBe('unknown error');
    // The regression, stated directly: the old expression yielded ''.
    expect(headCountError.message ?? 'unknown error').toBe('');
  });

  it('prefers message, then falls through code, details and hint', () => {
    expect(describeReadError({ message: 'Unregistered API key' })).toBe('Unregistered API key');
    expect(describeReadError({ message: '', code: 'PGRST205' })).toBe('PGRST205');
    expect(describeReadError({ message: '', code: '', details: 'relation missing' })).toBe('relation missing');
    expect(describeReadError({ message: '', code: '', details: '', hint: 'run the migration' })).toBe('run the migration');
  });

  it('treats a whitespace-only message as blank', () => {
    expect(describeReadError({ message: '   ', code: '42P01' })).toBe('42P01');
  });

  it('handles the shapes a settled rejection can actually carry', () => {
    expect(describeReadError(new Error('CONNECT_TIMEOUT'))).toBe('CONNECT_TIMEOUT');
    expect(describeReadError('fetch failed')).toBe('fetch failed');
    expect(describeReadError(null)).toBe('unknown error');
    expect(describeReadError(undefined)).toBe('unknown error');
    expect(describeReadError({})).toBe('unknown error');
  });

  it('falls back to the name when an Error carries no message', () => {
    expect(describeReadError(new TypeError())).toBe('TypeError');
  });
});

describe('isCredentialError', () => {
  // Every string here was observed in production on 2026-09-07, from a
  // service-role key Supabase would not accept.
  it.each([
    'Unregistered API key',
    'Invalid API key',
    'No API key found in request',
    'Invalid Compact JWS',
    'JWSError JWSInvalidSignature',
  ])('recognises %s as a credential rejection', (message) => {
    expect(isCredentialError({ message })).toBe(true);
  });

  it('does not mistake an ordinary per-table failure for a credential fault', () => {
    expect(isCredentialError({ message: 'relation "public.support_tickets" does not exist' })).toBe(false);
    expect(isCredentialError({ message: 'CONNECT_TIMEOUT' })).toBe(false);
    expect(isCredentialError({ message: '', code: 'PGRST205' })).toBe(false);
    expect(isCredentialError(null)).toBe(false);
  });
});

describe('credentialHint', () => {
  it('names the variable and where to set it, so the banner is actionable', () => {
    const hint = credentialHint(['families: Unregistered API key']);
    expect(hint).toBe(SERVICE_ROLE_KEY_HINT);
    expect(hint).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(hint).toContain('Vercel');
  });

  it('stays silent when the failures are ordinary read errors', () => {
    expect(credentialHint(['support tickets: relation does not exist'])).toBeUndefined();
    expect(credentialHint([])).toBeUndefined();
  });

  it('fires when only some reads carry the credential signature', () => {
    expect(credentialHint([
      'support tickets: relation does not exist',
      'families: Unregistered API key',
    ])).toBe(SERVICE_ROLE_KEY_HINT);
  });
});
