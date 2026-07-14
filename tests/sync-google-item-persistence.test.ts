import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = readFileSync('lib/sync/engine/google.ts', 'utf8');

describe('Google sync item persistence boundaries', () => {
  it('uses the shared fail-closed persistence guard', () => {
    expect(engine).toContain("from '@/lib/sync/persistence'");
    expect(engine).toContain('requireSyncWrite(');
  });

  it('checks Google pull-side rows, mappings, conflicts, and cursors', () => {
    expect(engine).toContain('event mapping creation');
    expect(engine).toContain('event conflict persistence');
    expect(engine).toContain('event mapping update');
    expect(engine).toContain('calendar cursor persistence');
    expect(engine).toContain('reminder mapping creation');
    expect(engine).toContain('reminder conflict persistence');
  });

  it('checks Google push-side mappings and local-row transitions', () => {
    expect(engine).toContain('event mapping deletion');
    expect(engine).toContain('exported event mapping creation');
    expect(engine).toContain('exported event mapping update');
    expect(engine).toContain('reminder mapping deletion');
    expect(engine).toContain('exported reminder mapping creation');
    expect(engine).toContain('exported reminder mapping update');
  });
});
