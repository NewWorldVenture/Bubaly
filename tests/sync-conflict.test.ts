import { describe, expect, it } from 'vitest';
import { detectConflict, type SyncItemState } from '@/lib/sync/conflict';

const base: SyncItemState = {
  baseHash: 'h0',
  localHash: 'h0',
  remoteHash: 'h0',
};

describe('detectConflict', () => {
  it('reports no conflict when nothing changed', () => {
    expect(detectConflict(base).conflict).toBe(false);
  });

  it('reports no conflict when only the local side changed', () => {
    const r = detectConflict({ ...base, localHash: 'h1' });
    expect(r.conflict).toBe(false);
  });

  it('reports no conflict when only the remote side changed', () => {
    const r = detectConflict({ ...base, remoteHash: 'h2' });
    expect(r.conflict).toBe(false);
  });

  it('detects both_edited when each side diverged differently', () => {
    const r = detectConflict({ ...base, localHash: 'h1', remoteHash: 'h2' });
    expect(r.conflict).toBe(true);
    expect(r.kind).toBe('both_edited');
  });

  it('does NOT conflict when both sides made the identical edit', () => {
    const r = detectConflict({ ...base, localHash: 'same', remoteHash: 'same' });
    expect(r.conflict).toBe(false);
  });

  it('suggests the most recently edited side for both_edited', () => {
    const newer = detectConflict({
      ...base, localHash: 'h1', remoteHash: 'h2',
      localUpdatedAt: '2026-06-20T10:00:00Z', remoteUpdatedAt: '2026-06-20T09:00:00Z',
    });
    expect(newer.suggested).toBe('keep_local');
    const older = detectConflict({
      ...base, localHash: 'h1', remoteHash: 'h2',
      localUpdatedAt: '2026-06-20T08:00:00Z', remoteUpdatedAt: '2026-06-20T09:00:00Z',
    });
    expect(older.suggested).toBe('keep_remote');
  });

  it('detects delete-vs-edit (local delete, remote edit)', () => {
    const r = detectConflict({ ...base, localDeleted: true, remoteHash: 'h2' });
    expect(r.conflict).toBe(true);
    expect(r.kind).toBe('deleted_vs_edited');
    expect(r.suggested).toBeNull();
  });

  it('detects delete-vs-edit (remote delete, local edit)', () => {
    const r = detectConflict({ ...base, remoteDeleted: true, localHash: 'h1' });
    expect(r.conflict).toBe(true);
    expect(r.kind).toBe('deleted_vs_edited');
  });

  it('treats both-deleted as converged (no conflict)', () => {
    const r = detectConflict({ ...base, localDeleted: true, remoteDeleted: true });
    expect(r.conflict).toBe(false);
  });

  it('detects completion-vs-edit for reminders', () => {
    const r = detectConflict({
      ...base, localHash: 'h1', remoteHash: 'h2',
      localCompleted: true, remoteCompleted: false,
    });
    expect(r.conflict).toBe(true);
    expect(r.kind).toBe('completed_vs_edited');
  });
});
