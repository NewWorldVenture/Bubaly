import { describe, expect, it, vi } from 'vitest';
import { submitProofAttempt, type ProofSubmitDeps } from '@/lib/chores/proof-submit';
import { releaseUnreferencedProof } from '@/lib/chores/proof-cleanup';
import { isProofPathFor, proofFileName, proofObjectPath } from '@/lib/chores/proof-media';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * One attempt to submit chore proof from the child's browser, and what it may
 * release. The uploads are released only when it is KNOWN that nothing of the
 * attempt was kept — an upload failed, or the action refused — and even then
 * only the objects no submission references. When the action's answer is lost,
 * nothing is released: the submission may have been recorded.
 */

const FAMILY = 'family-1';
const KID = 'member-kid';
const ids = ['6f9619ff-8b86-4011-b42d-00c04fc964ff', '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d'];
const file = (name: string) => new File([new Uint8Array([0xff, 0xd8])], name, { type: 'image/jpeg' });
const input = (names: string[]) => ({ assignmentId: 'assign-1', familyId: FAMILY, memberId: KID, note: 'done', files: names.map(file) });

function deps(over: Partial<ProofSubmitDeps> = {}) {
  let n = 0;
  const calls = { uploads: [] as string[], released: [] as string[][], forms: [] as FormData[] };
  const d: ProofSubmitDeps = {
    upload: async (path) => { calls.uploads.push(path); return { error: null }; },
    release: async (paths) => { calls.released.push([...paths]); },
    submit: async (form) => { calls.forms.push(form); return { ok: true }; },
    newId: () => ids[n++ % ids.length],
    ...over,
  };
  return { d, calls };
}

describe('submitProofAttempt', () => {
  it('uploads each file to the member folder and sends only the paths', async () => {
    const { d, calls } = deps();
    expect(await submitProofAttempt(input(['a.jpg', 'b.jpg']), d)).toEqual({ kind: 'sent' });
    expect(calls.uploads).toEqual([`${FAMILY}/${KID}/${ids[0]}-a.jpg`, `${FAMILY}/${KID}/${ids[1]}-b.jpg`]);
    const form = calls.forms[0];
    expect(form.getAll('media_path')).toEqual(calls.uploads);
    expect([...form.keys()].sort()).toEqual(['assignment_id', 'media_path', 'media_path', 'note']);
    expect([...form.values()].some((v) => v instanceof File)).toBe(false);
    expect(calls.released).toEqual([]);
  });

  it('an upload that fails releases what this attempt uploaded, including the failed one, and submits nothing', async () => {
    let i = 0;
    const { d, calls } = deps({ upload: async (path) => { calls.uploads.push(path); return { error: i++ === 1 ? { message: 'network' } : null }; } });
    expect(await submitProofAttempt(input(['a.jpg', 'b.jpg']), d)).toEqual({ kind: 'upload_failed' });
    expect(calls.forms).toEqual([]);
    expect(calls.released).toEqual([calls.uploads]);
  });

  it('an upload whose response is lost (it threw) is released too: it may have stored', async () => {
    const { d, calls } = deps({ upload: async (path) => { calls.uploads.push(path); throw new Error('connection reset'); } });
    expect(await submitProofAttempt(input(['a.jpg']), d)).toEqual({ kind: 'upload_failed' });
    expect(calls.released).toEqual([[`${FAMILY}/${KID}/${ids[0]}-a.jpg`]]);
  });

  it('a refusal from the action releases the attempt (the release itself spares anything referenced)', async () => {
    const { d, calls } = deps({ submit: async () => ({ ok: false, error: 'Chore not found' }) });
    expect(await submitProofAttempt(input(['a.jpg']), d)).toEqual({ kind: 'refused', error: 'Chore not found' });
    expect(calls.released).toEqual([calls.uploads]);
  });

  it('a lost answer from the action releases nothing: the proof may be recorded', async () => {
    const { d, calls } = deps({ submit: async () => { throw new Error('fetch failed'); } });
    expect(await submitProofAttempt(input(['a.jpg']), d)).toEqual({ kind: 'unknown' });
    expect(calls.released).toEqual([]);
  });

  it('runs to its outcome without the form: leaving the page mid-attempt changes nothing it decides', async () => {
    // The attempt holds no component state; a navigation or unmount while it
    // runs only means nobody reads the outcome. A refusal still releases, a
    // lost answer still keeps.
    let finish!: (r: { ok: boolean }) => void;
    const { d, calls } = deps({ submit: () => new Promise((resolve) => { finish = resolve; }) });
    const pending = submitProofAttempt(input(['a.jpg']), d);
    await vi.waitFor(() => expect(calls.uploads).toHaveLength(1));
    finish({ ok: false });
    expect(await pending).toEqual({ kind: 'refused', error: undefined });
    expect(calls.released).toEqual([calls.uploads]);
  });

  it('a failing release does not turn a refusal into an error', async () => {
    const { d } = deps({ submit: async () => ({ ok: false }), release: async () => { throw new Error('offline'); } });
    expect(await submitProofAttempt(input(['a.jpg']), d)).toEqual({ kind: 'refused', error: undefined });
  });
});

describe('releaseUnreferencedProof', () => {
  const held = `${FAMILY}/${KID}/${ids[0]}-old.jpg`;
  const fresh = `${FAMILY}/${KID}/${ids[1]}-new.jpg`;
  function client(removeResult: { error: unknown } = { error: null }, failRead = false) {
    const db = createInMemorySupabase();
    db.seed('chore_submissions', [{ id: 's1', family_id: FAMILY, member_id: KID, media_paths: [held] }]);
    const removed: string[][] = [];
    const c = new Proxy(db as object, {
      get: (t, prop) => {
        if (prop === 'storage') return { from: () => ({ remove: async (p: string[]) => { removed.push(p); return removeResult; } }) };
        if (prop === 'from' && failRead) return () => ({ select: () => ({ eq: () => ({ overlaps: async () => ({ data: null, error: { message: 'down' } }) }) }) });
        return Reflect.get(t, prop);
      },
    });
    return { c: c as never, removed };
  }

  it('removes only what no submission references', async () => {
    const { c, removed } = client();
    expect(await releaseUnreferencedProof(c, FAMILY, [held, fresh, fresh])).toEqual([fresh]);
    expect(removed).toEqual([[fresh]]);
  });

  it('removes nothing when it cannot tell what is referenced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { c, removed } = client({ error: null }, true);
    expect(await releaseUnreferencedProof(c, FAMILY, [fresh])).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('reports nothing removed when Storage refuses the removal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { c } = client({ error: { message: 'denied' } });
    expect(await releaseUnreferencedProof(c, FAMILY, [fresh])).toEqual([]);
  });
});

describe('every name the uploader makes is a path the action accepts', () => {
  it.each(['bed..jpg', '..jpg', 'a...b....c.png', '../../etc/passwd', 'ça va?.heic', '', '.', `${'x'.repeat(300)}.jpg`, 'proof (1).JPG'])('%j', (name) => {
    const path = proofObjectPath(FAMILY, KID, ids[0], name);
    expect(proofFileName(name)).not.toContain('..');
    expect(isProofPathFor(path, FAMILY, KID)).toBe(true);
  });
});
