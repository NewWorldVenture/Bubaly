import { describe, expect, it } from 'vitest';
import { isRetryableAuthError as web } from '@/lib/auth/session';
import { isRetryableAuthError as mobile } from '../mobile/src/lib/auth-core';

// Literal records only. No SDK error constructors, Auth/coordinator imports,
// requests, session/storage changes, timers or native failure probes.
const unknownReads = [
  { label: 'an unparseable error body with no status or code', value: { name: 'AuthUnknownError', message: 'Unexpected end of JSON input' } },
  { label: 'the SDK-shaped unknown wrapper with absent rejection metadata', value: { name: 'AuthUnknownError', __isAuthError: true, message: 'Unexpected token < in JSON at position 0', status: undefined, code: undefined, originalError: { name: 'SyntaxError', message: 'Unexpected token <' } } },
] as const;

const transient = [
  { label: 'named retryable fetch error', value: { name: 'AuthRetryableFetchError', message: 'unavailable' } },
  { label: 'server failure', value: { status: 503, message: 'unavailable' } },
  { label: 'server internal failure', value: { status: 500 } },
  { label: 'timeout', value: { status: 408 } },
  { label: 'rate limit', value: { status: 429 } },
  { label: 'transport status zero', value: { status: 0 } },
  { label: 'coded unexpected failure', value: { code: 'unexpected_failure' } },
  { label: 'unreadable session storage', value: { code: 'session_storage_unavailable' } },
  { label: 'coded network failure', value: { code: 'network_error' } },
  { label: 'coded request timeout', value: { code: 'request_timeout' } },
  { label: 'coded request rate limit', value: { code: 'over_request_rate_limit' } },
  { label: 'failed fetch text', value: { name: 'Error', message: 'fetch failed' } },
  { label: 'socket hang-up text', value: { name: 'Error', message: 'socket hang up' } },
  { label: 'network reset text', value: { name: 'Error', message: 'ECONNRESET' } },
] as const;

const definitive = [
  { label: 'missing session', value: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 } },
  { label: 'used refresh token', value: { name: 'AuthApiError', message: 'Invalid Refresh Token: Already Used', status: 401, code: 'refresh_token_already_used' } },
  { label: 'missing refresh token', value: { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' } },
  { label: 'invalid JWT', value: { name: 'AuthApiError', status: 401, code: 'bad_jwt' } },
  { label: 'authorization refusal', value: { name: 'AuthApiError', status: 403, code: 'user_banned' } },
  { label: 'existing invalid-refresh error text', value: { name: 'Error', message: 'Invalid Refresh Token' } },
  { label: 'unknown-shaped response carrying an explicit unauthorized status', value: { name: 'AuthUnknownError', status: 401, message: 'unparseable' } },
  { label: 'unknown-shaped response carrying an explicit forbidden status', value: { name: 'AuthUnknownError', status: 403, message: 'unparseable' } },
  { label: 'unknown-shaped response carrying an explicit bad JWT code', value: { name: 'AuthUnknownError', code: 'bad_jwt', message: 'unparseable' } },
  { label: 'unknown-shaped response carrying an explicit missing-refresh code', value: { name: 'AuthUnknownError', code: 'refresh_token_not_found', message: 'unparseable' } },
  { label: 'unknown-shaped response carrying an explicit used-refresh rejection', value: { name: 'AuthUnknownError', status: 400, code: 'refresh_token_already_used', message: 'unparseable' } },
] as const;

const nonErrors = [
  { label: 'null', value: null }, { label: 'undefined', value: undefined },
  { label: 'string', value: 'not an auth error' }, { label: 'number', value: 3 },
  { label: 'boolean', value: false }, { label: 'empty record', value: {} },
  { label: 'unrecognized named error', value: { name: 'SomeOtherError', message: 'unclassified' } },
] as const;

describe.each([{ platform: 'web', classify: web }, { platform: 'mobile', classify: mobile }])('$platform classifies returned auth-read evidence', ({ classify }) => {
  it.each(unknownReads)('keeps $label unavailable rather than claiming sign-out', ({ value }) => {
    expect(classify(value)).toBe(true);
  });
  it.each(transient)('preserves the known transient control: $label', ({ value }) => {
    expect(classify(value)).toBe(true);
  });
  it.each(definitive)('preserves the definitive rejection control: $label', ({ value }) => {
    expect(classify(value)).toBe(false);
  });
  it.each(nonErrors)('does not invent auth evidence from $label', ({ value }) => {
    expect(classify(value)).toBe(false);
  });
});

it('keeps web and mobile classifications identical for every literal control', () => {
  for (const { value } of [...unknownReads, ...transient, ...definitive, ...nonErrors]) {
    expect(web(value)).toBe(mobile(value));
  }
});

it('does not mutate or replace the supplied literal evidence', () => {
  for (const { value } of [...unknownReads, ...transient, ...definitive, ...nonErrors]) {
    const before = JSON.stringify(value);
    if (value && typeof value === 'object') Object.freeze(value);
    web(value); mobile(value);
    expect(JSON.stringify(value)).toBe(before);
  }
});
