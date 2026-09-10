import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const generic = readFileSync('lib/sync/engine/generic.ts', 'utf8');
const google = readFileSync('lib/sync/engine/google.ts', 'utf8');
const tokens = readFileSync('lib/sync/access-token.ts', 'utf8');

describe('sync job persistence boundaries', () => {
  it('requires job and run creation before provider work begins', () => {
    for (const source of [generic, google]) {
      expect(source).toContain('Sync job could not be created');
      expect(source).toContain('Sync run could not be created');
      expect(source).toContain('job_id: job.id');
    }
  });

  it('requires run, job, connection, and account finalization', () => {
    for (const source of [generic, google]) {
      expect(source).toContain('Sync run finalization failed');
      expect(source).toContain('Sync job finalization failed');
      expect(source).toContain('Sync connection finalization failed');
      expect(source).toContain('Sync account finalization failed');
      expect(source).toContain(".select('id').maybeSingle()");
    }
  });

  it('does not return a refreshed generic token before encrypted persistence', () => {
    expect(generic).toContain('getProviderAccessToken');
    expect(tokens).toContain('if (result.error || !result.data) throw');
    expect(tokens).toContain(".select('account_id').maybeSingle()");
  });
});
