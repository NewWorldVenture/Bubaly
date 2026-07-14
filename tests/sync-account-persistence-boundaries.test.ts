import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('lib/sync/accounts.ts', 'utf8');

describe('sync account persistence boundaries', () => {
  it('does not overwrite a refresh token when its prerequisite read fails', () => {
    expect(source).toContain('existingError');
    expect(source).toContain('Failed to read the stored refresh token');
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
