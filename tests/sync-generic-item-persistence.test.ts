import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

const engine = readFileSync('lib/sync/engine/generic.ts', 'utf8');
const persistence = readFileSync('lib/sync/persistence.ts', 'utf8');

describe('generic sync item persistence boundaries', () => {
  it('uses one fail-closed guard for row state transitions', () => {
    expect(persistence).toContain('requireSyncWrite');
    expect(persistence).toContain('Sync ${operation} failed');
    expect(engine).toContain("from '@/lib/sync/persistence'");
    expect(engine).toContain('requireSyncWrite(');
  });

  // The pre-0494 adoption takeover's invariant: every item write is fenced on
  // an updated_at read BEFORE the proof (the mapping compare-and-set, or the
  // token re-check) that authorizes it. at()/bodyOf() assert presence, so
  // deleting the pre-read, the re-check or the fence fails instead of passing
  // on indexOf's -1.
  it('reads the item fence before the mapping compare-and-set, fences the touch on it, and re-proves the token before any re-touch', () => {
    const body = bodyOf(persistence, 'export async function takeOverPendingAdoption', 'return { token, fence:');
    const read = at(body, 'const before = await readAdoptionFence(');
    const cas = at(body, "adoptionMeta({ state: 'syncing', token })");
    const touch = at(body, 'await touchAdoptedItem(admin, kind, containerId, scope, before)');
    expect(read).toBeLessThan(cas);
    expect(cas).toBeLessThan(touch);
    const again = at(body, 'const again = await readAdoptionFence(');
    const recheck = at(body, '.eq(ADOPTION_TOKEN, token).maybeSingle()');
    const retouch = at(body, 'await touchAdoptedItem(admin, kind, containerId, scope, again)');
    expect(touch).toBeLessThan(again);
    expect(again).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(retouch);
    expect(bodyOf(persistence, 'async function touchAdoptedItem', ".select('id, updated_at').maybeSingle();")).toContain('updated_at: updatedAt');
  });

  it('checks pull-side creation, mappings, conflicts, updates, and cursors', () => {
    expect(engine).toContain('createSyncPullItem(');
    expect(engine).toContain('event conflict persistence');
    expect(engine).toContain('event mapping update');
    expect(engine).toContain('calendar cursor persistence');
    expect(engine).toContain("'reminder', list.id, row.external_id");
    expect(engine).toContain('reminder conflict persistence');
  });

  it('checks push-side mapping and local-row transitions before counting exports', () => {
    expect(engine).toContain('event mapping deletion');
    expect(engine).toContain('event mapping creation');
    expect(engine).toContain('exported event mapping update');
    expect(engine).toContain('reminder mapping deletion');
    expect(engine).toContain('exported reminder mapping creation');
    expect(engine).toContain('exported reminder mapping update');
  });
});
