import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = readFileSync('lib/sync/engine/generic.ts', 'utf8');
const persistence = readFileSync('lib/sync/persistence.ts', 'utf8');

describe('generic sync item persistence boundaries', () => {
  it('uses one fail-closed guard for row state transitions', () => {
    expect(persistence).toContain('requireSyncWrite');
    expect(persistence).toContain('Sync ${operation} failed');
    expect(engine).toContain("from '@/lib/sync/persistence'");
    expect(engine).toContain('requireSyncWrite(');
  });

  it('checks pull-side creation, mappings, conflicts, updates, and cursors', () => {
    expect(engine).toContain('event mapping creation');
    expect(engine).toContain('event conflict persistence');
    expect(engine).toContain('event mapping update');
    expect(engine).toContain('calendar cursor persistence');
    expect(engine).toContain('reminder mapping creation');
    expect(engine).toContain('reminder conflict persistence');
  });

  it('checks push-side mapping and local-row transitions before counting exports', () => {
    expect(engine).toContain('event mapping deletion');
    expect(engine).toContain('exported event mapping creation');
    expect(engine).toContain('exported event mapping update');
    expect(engine).toContain('reminder mapping deletion');
    expect(engine).toContain('exported reminder mapping creation');
    expect(engine).toContain('exported reminder mapping update');
  });
});
