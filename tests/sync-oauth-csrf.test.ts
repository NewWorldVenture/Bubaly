import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSyncOAuthState,
  syncOAuthStateCookie,
  syncOAuthStatePath,
  verifySyncOAuthState,
} from '@/lib/sync/oauth-state';

const root = process.cwd();
const googleAuth = readFileSync(resolve(root, 'app/api/sync/google/auth/route.ts'), 'utf8');
const googleCallback = readFileSync(resolve(root, 'app/api/sync/google/callback/route.ts'), 'utf8');
const providerAuth = readFileSync(resolve(root, 'app/api/sync/[provider]/auth/route.ts'), 'utf8');
const providerCallback = readFileSync(resolve(root, 'app/api/sync/[provider]/callback/route.ts'), 'utf8');

describe('sync OAuth CSRF protection', () => {
  it('creates high-entropy state and only accepts an exact match', () => {
    const state = createSyncOAuthState();
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect(verifySyncOAuthState(state, state)).toBe(true);
    expect(verifySyncOAuthState(`${state}x`, state)).toBe(false);
    expect(verifySyncOAuthState(null, state)).toBe(false);
    expect(verifySyncOAuthState(state, null)).toBe(false);
  });

  it('scopes state cookies to the provider callback path', () => {
    expect(syncOAuthStateCookie('google')).toBe('sync_oauth_state_google');
    expect(syncOAuthStatePath('microsoft')).toBe('/api/sync/microsoft');
  });

  it('uses opaque cookie-bound state and session-derived identity in both callback families', () => {
    for (const source of [googleAuth, providerAuth]) {
      expect(source).toContain('createSyncOAuthState()');
      expect(source).toContain('httpOnly: true');
      expect(source).not.toContain('JSON.stringify({ userId:');
    }
    for (const source of [googleCallback, providerCallback]) {
      expect(source).toContain('verifySyncOAuthState');
      expect(source).toContain('maxAge: 0');
      expect(source).not.toContain('JSON.parse(Buffer.from(stateRaw');
    }
  });
});
