// The report to the user must not sit downstream of a call that fails for the
// same reason the user is being told about.
//
// `voice-module.tsx`'s catch block read:
//
//   } catch (err) {
//     journey.abandon();
//     await sb.from('voice_commands').insert({ …, status: 'failed' }).select('id');
//     toastError(describeDbError(err, …));            // ← never reached
//
// supabase-js returns `{ error }` for a PostgREST refusal but REJECTS when the
// underlying fetch fails. With the network down — the ordinary reason a voice
// command fails at all — that insert rejected, the rejection escaped the catch,
// and `toastError` was never called. `finally` still cleared the spinner, so
// the user saw the command stop and was told nothing whatsoever.
//
// The same file's success-path write discarded its error on purpose ("a logging
// failure must not lose the thing we just created") and did not even log it, so
// a history that had stopped recording was indistinguishable from a family that
// had stopped speaking.
//
// Both writes now go through `recordVoiceCommand`, whose contract is the fix:
// it cannot reject, so nothing sequenced after it can be lost. The module also
// calls `toastError` BEFORE it, so the ordering does not rely on that contract
// alone — two independent reasons the user is told. Audit C1-S8-06.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { recordVoiceCommand, type VoiceHistoryRow } from '@/lib/voice/history';

const ROW: VoiceHistoryRow = {
  family_id: 'family-1', member_id: 'member-1', transcript: 'add milk',
  resolved_kind: 'shopping', status: 'failed', created_by: 'user-1',
};

function clientWhere(insert: () => unknown): SupabaseClient<Database> {
  return { from: () => ({ insert }) } as unknown as SupabaseClient<Database>;
}

describe('recordVoiceCommand cannot take the user’s error message down with it', () => {
  it('resolves when the insert REJECTS — the offline case', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = clientWhere(() => Promise.reject(new TypeError('Failed to fetch')));
    // The assertion is that this does not reject. `.resolves` states it
    // directly rather than relying on the test not throwing.
    await expect(recordVoiceCommand(sb, ROW)).resolves.toBeUndefined();
    expect(errors, 'a dropped history row was not reported anywhere').toHaveBeenCalled();
    errors.mockRestore();
  });

  it('resolves when the insert THROWS synchronously', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = clientWhere(() => { throw new Error('client is not configured'); });
    await expect(recordVoiceCommand(sb, ROW)).resolves.toBeUndefined();
    errors.mockRestore();
  });

  it('logs a PostgREST refusal rather than discarding it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = clientWhere(() => Promise.resolve({ error: { code: '42501', message: 'permission denied' } }));
    await recordVoiceCommand(sb, ROW);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('says nothing when the row lands', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sb = clientWhere(() => Promise.resolve({ error: null }));
    await recordVoiceCommand(sb, ROW);
    expect(errors, 'a successful write should be quiet').not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('the module keeps the order that made the contract necessary', () => {
  const src = readFileSync('components/modules/voice-module.tsx', 'utf8');
  const block = src.slice(src.indexOf('} catch (err) {'), src.indexOf('} finally {'));

  it('has a catch block to look at', () => {
    // Without this the slice could be empty and every assertion below vacuous —
    // C4-S5-01's class.
    expect(block.length).toBeGreaterThan(80);
    expect(block).toContain('journey.abandon()');
  });

  it('tells the user before it writes the history row', () => {
    const told = block.indexOf('toastError(');
    const wrote = block.indexOf('recordVoiceCommand(');
    expect(told, 'the catch block no longer tells the user at all').toBeGreaterThan(-1);
    expect(wrote, 'the catch block no longer records the attempt').toBeGreaterThan(-1);
    expect(told, 'the user is told AFTER the history write again').toBeLessThan(wrote);
  });

  it('never writes voice_commands directly, in either path', () => {
    // A bare insert is the shape that shipped; both paths go through the helper.
    expect(src).not.toMatch(/from\('voice_commands'\)\s*\.\s*insert\(/);
  });
});
