import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Client silent-WRITE-failure sweep (agent-02, components/ outside components/modules/).
// Two fixes locked here:
//   1. Memories "undo" — deleting a just-created memory dropped the DB-delete error
//      and unconditionally said "nothing was saved", so a failed delete left the
//      photo live in Photos/Favorites while the user believed it was gone.
//   2. Moments organizer "dismiss" — on a failed dismiss it rolled the optimistic
//      hide back but said nothing, so the card silently reappeared with no reason.

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('memories create-memory undo surfaces a failed delete', () => {
  const src = read('components/memories/create-memory.tsx');

  it('checks the family_photos delete error inside undo()', () => {
    const undo = src.slice(src.indexOf('async function undo('));
    // The delete must capture and branch on its error, not fire-and-forget.
    expect(/const \{ error: delErr \} = await supabase\.from\('family_photos'\)\.delete\(\)/.test(undo)).toBe(true);
    expect(/if \(delErr\)/.test(undo)).toBe(true);
  });

  it('does not claim success before the delete is confirmed', () => {
    const start = src.indexOf('async function undo(');
    const undo = src.slice(start, src.indexOf('async function', start + 20));
    const successIdx = undo.indexOf("success(t('createMemory.memoryUndoneNothingWasSaved')");
    const guardIdx = undo.indexOf('if (delErr)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(guardIdx); // success only after the error guard
  });
});

describe('moments organizer dismiss surfaces a failed write', () => {
  const src = read('components/moments/moment-organizer.tsx');

  it('imports a toast and reports the error on rollback', () => {
    expect(src.includes("from '@/components/ui/toast'")).toBe(true);
    const dismiss = src.slice(src.indexOf('function dismiss('), src.indexOf('function dismiss(') + 500);
    // On !res.ok it must both roll back AND toast — not silently revert.
    expect(/toastError\(/.test(dismiss)).toBe(true);
  });
});
