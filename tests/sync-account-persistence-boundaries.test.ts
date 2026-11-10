import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

const source = readFileSync('lib/sync/accounts.ts', 'utf8');

describe('sync account persistence boundaries', () => {
  it('does not overwrite a refresh token when its prerequisite read fails', () => {
    expect(source).toContain('existingError');
    expect(source).toContain('Failed to read the stored refresh token');
    // The guard itself, in the block that preserves the stored token: both
    // strings above also occur without it (the destructuring, getRefreshToken).
    const preserve = bodyOf(source, '// Preserve an existing refresh token', "await admin.from('sync_tokens').upsert(");
    const read = at(preserve, "const { data: existing, error: existingError } = await admin");
    const guard = at(preserve, "if (existingError) throw new Error('Failed to read the stored refresh token');");
    expect(read).toBeLessThan(guard);
    expect(guard).toBeLessThan(at(preserve, 'refreshEnc = existing?.refresh_token_enc ?? null;'));
  });

  it('requires account, token, and connection writes to succeed', () => {
    expect(source).toContain('Failed to upsert sync account');
    expect(source).toContain('Failed to store sync tokens');
    expect(source).toContain(".select('account_id').maybeSingle()");
    expect(source).toContain('Failed to persist the sync connection');
  });

  it('fails closed when an access-token refresh cannot be persisted', () => {
    expect(source).toContain('Failed to persist the refreshed sync token');
    expect(source).not.toContain('Failed to upsert sync account: ${accErr?.message}');
  });
});
