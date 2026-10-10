import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Chore proof reaches submitProofAction as Storage paths, not as file bytes.
 *
 * The kid's form used to put the photo or video in the server action's
 * FormData. Next caps a server action's body at 1 MB unless next.config raises
 * it, and this app does not, so an ordinary phone photo (2-5 MB) and every
 * video were refused with a 413 before the action ran — the action's own 50 MB
 * allowance was never reachable. The form now uploads straight to the child's
 * own `chore-proof` folder (0376's write policy) and sends only the paths; the
 * action checks each path is one object in THIS assignment's member folder and
 * that what Storage holds — its real type and size, not the browser's claim —
 * is proof media. SVG, HTML and XML are refused (SEC-002 R1).
 *
 * While it works on the paths it holds their claims (lib/chores/proof-cleanup),
 * so a release cannot remove a path between the action's checks and the row
 * that records it; the interleavings are below, with the claim bypassed as
 * the control that shows the harness reproduces the loss.
 */

const FAMILY = 'family-1';
const KID = 'member-kid';
const SIB = 'member-sib';
const UUID = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const UUID2 = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
const kidPath = (id = UUID, name = 'proof.jpg') => `${FAMILY}/${KID}/${id}-${name}`;

type Stored = { contentType: string; size: number; bytes?: Uint8Array<ArrayBuffer> };
const harness = vi.hoisted(() => ({
  db: null as unknown,
  objects: new Map<string, { contentType: string; size: number; bytes?: Uint8Array<ArrayBuffer> }>(),
  /** Proof objects removed (claims are counted apart, in `unclaimed`). */
  removed: [] as string[],
  unclaimed: [] as string[],
  reviewed: [] as { media_type: string; data: string }[][],
  /** What the reviewer concludes from what it was shown. */
  verdict: 'review' as 'approve' | 'reject' | 'improve' | 'review',
  rewarded: 0,
  failDownload: new Set<string>(),
  /** Interleaving points: run before Storage answers info() / acts on remove(). */
  onInfo: null as null | ((path: string) => Promise<void>),
  /** Resolving to an answer makes remove() answer with it instead of removing. */
  onRemove: null as null | ((paths: string[]) => Promise<void | { data: null; error: unknown }>),
  memberId: 'member-kid',
  role: 'child',
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: {
      familyId: 'family-1', role: harness.role,
      member: { id: harness.memberId, family_id: 'family-1' }, family: { id: 'family-1', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/chores/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chores/ai')>()),
  validateChoreSubmission: async (_scope: unknown, input: { images?: { media_type: string; data: string }[] }) => {
    harness.reviewed.push(input.images ?? []);
    const base = { confidence: 0.9, recommended_reward_type: 'none', recommended_reward_amount: 0, parent_summary: 'done',
      detected_issues: [], safety_flags: [], model: 'test', is_fallback: false };
    switch (harness.verdict) {
      // Each a conclusion the reviewer reached on its own, with no human asked for.
      case 'approve': return { ...base, status: 'approved', quality_score: 95, kid_feedback: 'great', needs_parent_review: false };
      case 'reject': return { ...base, status: 'rejected', quality_score: 5, kid_feedback: 'not done', needs_parent_review: false };
      case 'improve': return { ...base, status: 'needs_improvement', quality_score: 40, kid_feedback: 'almost', needs_parent_review: false };
      default: return { ...base, status: 'needs_review', quality_score: 50, confidence: 0.5, kid_feedback: 'ok', parent_summary: 'ok',
        needs_parent_review: true, is_fallback: true };
    }
  },
}));
// The payout itself is lib/chores/server's; here only whether it ran.
vi.mock('@/lib/chores/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chores/server')>()),
  applyCompletionRewards: async () => { harness.rewarded += 1; },
}));

const isClaim = (path: string) => path.includes('/claims/');

// The in-memory database, plus the Storage calls the action makes. An upload
// is only ever a claim (the proof bytes are already stored), and like
// Storage's own, an upload that does not upsert is refused when the object
// exists.
function withStorage(db: InMemorySupabase) {
  const bucket = {
    info: async (path: string) => {
      await harness.onInfo?.(path);
      const o = harness.objects.get(path);
      return o ? { data: { name: path, contentType: o.contentType, size: o.size, metadata: { mimetype: o.contentType, size: o.size } }, error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
    download: async (path: string) => {
      if (harness.failDownload.has(path)) return { data: null, error: { message: 'download failed' } };
      const o = harness.objects.get(path);
      return o?.bytes ? { data: new Blob([o.bytes]), error: null } : { data: null, error: { message: 'Object not found' } };
    },
    remove: async (paths: string[]) => {
      if (paths.some((p) => !isClaim(p))) {
        const answered = await harness.onRemove?.(paths);
        if (answered) return answered;
      }
      for (const p of paths) (isClaim(p) ? harness.unclaimed : harness.removed).push(p);
      paths.forEach((p) => harness.objects.delete(p));
      return { data: [], error: null };
    },
    upload: async (path: string, _body: unknown, options: { upsert?: boolean }) => {
      if (!isClaim(path)) throw new Error('the action must not upload proof bytes itself any more');
      expect(options.upsert).toBe(false);
      if (harness.objects.has(path)) return { data: null, error: { statusCode: '409', message: 'The resource already exists' } };
      harness.objects.set(path, { contentType: 'text/plain', size: 0 });
      return { data: { path }, error: null };
    },
  };
  return new Proxy(db as object, {
    get: (target, prop) => (prop === 'storage' ? { from: (name: string) => { expect(name).toBe('chore-proof'); return bucket; } } : Reflect.get(target, prop)),
  });
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));

const { submitProofAction } = await import('@/app/(app)/missions/actions');
const { releaseUnreferencedProof, proofClaimPath } = await import('@/lib/chores/proof-cleanup');
/** Claims nobody took: a release handed these reads and removes with no claim at all (the control). */
const unclaimed = (held: string[]) => ({ held, keep: () => {}, letGo: async () => {} });
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const UPLOAD_FAILED = translate(SOURCE_MESSAGES, 'actions.couldNotUploadProofMedia');

function store(path: string, o: Stored) { harness.objects.set(path, o); }
function submit(paths: string[], note = 'all done') {
  const form = new FormData();
  form.set('assignment_id', 'assign-1');
  form.set('note', note);
  for (const p of paths) form.append('media_path', p);
  return submitProofAction(form);
}

let db: InMemorySupabase;
beforeEach(() => {
  harness.objects.clear();
  harness.removed = [];
  harness.unclaimed = [];
  harness.reviewed = [];
  harness.verdict = 'review';
  harness.rewarded = 0;
  harness.failDownload = new Set();
  harness.onInfo = null;
  harness.onRemove = null;
  harness.memberId = KID;
  harness.role = 'child';
  db = createInMemorySupabase();
  harness.db = withStorage(db);
  db.seed('chore_assignments', [{ id: 'assign-1', family_id: FAMILY, chore_id: 'chore-1', member_id: KID, status: 'pending' }]);
  db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Make the bed', proof_required: 'photo', auto_approve_score: null }]);
});
afterEach(() => {
  // Every claim taken is let go, whatever the outcome.
  expect([...harness.objects.keys()].filter(isClaim), 'claims left behind').toEqual([]);
});

/** Wraps the database so each chore_submissions insert is recorded, and chore_ai_validations writes can be refused. */
function recordInserts({ refuseVerdict = false } = {}) {
  const inserted: unknown[] = [];
  const real = db.from.bind(db);
  harness.db = new Proxy(harness.db as object, {
    get: (target, prop) => (prop === 'from'
      ? (table: string) => {
        if (table === 'chore_ai_validations' && refuseVerdict) return { insert: async () => ({ error: { message: 'refused' } }) };
        const q = real(table);
        if (table === 'chore_submissions') {
          const insert = q.insert.bind(q);
          q.insert = (rows) => { inserted.push(rows); return insert(rows); };
        }
        return q;
      }
      : Reflect.get(target, prop)),
  });
  return inserted;
}

describe('a proof photo already in the child’s folder is submitted by its path', () => {
  it('records a 3 MB photo — over the 1 MB a server action body may carry — and the reviewer sees it', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    store(kidPath(), { contentType: 'image/jpeg', size: 3 * 1024 * 1024, bytes });

    const res = await submit([kidPath()]);

    expect(res).toEqual({ ok: true });
    expect(db.table('chore_submissions')).toEqual([
      expect.objectContaining({ assignment_id: 'assign-1', member_id: KID, kind: 'photo', media_paths: [kidPath()], note: 'all done' }),
    ]);
    expect(harness.reviewed).toEqual([[{ media_type: 'image/jpeg', data: Buffer.from(bytes).toString('base64') }]]);
    expect(harness.removed).toEqual([]);
  });

  it('keeps a video for the parent without handing it to the image reviewer', async () => {
    db.table('chores')[0].proof_required = 'video';
    store(kidPath(UUID, 'clip.mov'), { contentType: 'video/quicktime', size: 40 * 1024 * 1024 });

    expect(await submit([kidPath(UUID, 'clip.mov')])).toEqual({ ok: true });
    expect(db.table('chore_submissions')[0]).toMatchObject({ media_paths: [kidPath(UUID, 'clip.mov')] });
    expect(harness.reviewed).toEqual([[]]);
  });

  it('lets a manager submit on the child’s behalf into the child’s folder', async () => {
    harness.memberId = 'member-parent';
    harness.role = 'parent';
    store(kidPath(), { contentType: 'image/png', size: 1000, bytes: new Uint8Array([1]) });
    expect(await submit([kidPath()])).toEqual({ ok: true });
  });
});

describe('what Storage holds decides, not the path or the browser', () => {
  it.each([
    ['an SVG, which a browser runs as a page', { contentType: 'image/svg+xml', size: 2000 }],
    ['HTML', { contentType: 'text/html', size: 2000 }],
    ['an empty object', { contentType: 'image/jpeg', size: 0 }],
    ['an object over 50 MB', { contentType: 'video/mp4', size: 50 * 1024 * 1024 + 1 }],
  ])('refuses %s, removes the upload and records nothing', async (_label, stored) => {
    store(kidPath(), stored);
    expect(await submit([kidPath()])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(db.table('chore_submissions')).toEqual([]);
    expect(harness.removed).toEqual([kidPath()]);
  });

  it('refuses a path with nothing behind it', async () => {
    expect(await submit([kidPath()])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(db.table('chore_submissions')).toEqual([]);
  });
});

describe('a path outside this assignment’s member folder is refused before anything is read', () => {
  it.each([
    ['a sibling’s folder', `${FAMILY}/${SIB}/${UUID}-proof.jpg`],
    ['another family', `family-2/${KID}/${UUID}-proof.jpg`],
    ['a nested path', `${FAMILY}/${KID}/x/${UUID}-proof.jpg`],
    ['a traversal', `${FAMILY}/${KID}/../${SIB}/${UUID}-proof.jpg`],
    ['a name without an object id', `${FAMILY}/${KID}/proof.jpg`],
  ])('refuses %s, writing and removing nothing outside the folder', async (_label, path) => {
    store(path, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    expect(await submit([path])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(db.table('chore_submissions')).toEqual([]);
    expect(harness.removed).not.toContain(path);
  });

  it('refuses more than four, and the same path twice', async () => {
    const ids = [UUID, UUID2, '11111111-2222-4333-8444-555555555555', '66666666-7777-4888-9999-aaaaaaaaaaaa', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'];
    ids.forEach((id) => store(kidPath(id), { contentType: 'image/jpeg', size: 10 }));
    expect(await submit(ids.map((id) => kidPath(id)))).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(await submit([kidPath(), kidPath()])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(db.table('chore_submissions')).toEqual([]);
  });

  it('still needs a photo for a photo chore', async () => {
    expect(await submit([])).toEqual({ ok: false, error: translate(SOURCE_MESSAGES, 'actions.thisChoreNeedsAPhoto') });
  });
});

describe('a refusal never costs an earlier submission its proof', () => {
  const held = kidPath(UUID, 'old.jpg');
  beforeEach(() => {
    store(held, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    db.seed('chore_submissions', [{ id: 'sub-old', family_id: FAMILY, assignment_id: 'assign-1', member_id: KID, media_paths: [held], status: 'approved' }]);
  });

  it('refuses a path an earlier submission holds, and leaves it in place', async () => {
    expect(await submit([held])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(harness.removed).toEqual([]);
    expect(harness.objects.has(held)).toBe(true);
    expect(db.table('chore_submissions')).toHaveLength(1);
  });

  it('refuses the same held path twice ([P,P]) without removing it', async () => {
    expect(await submit([held, held])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(harness.removed).toEqual([]);
    expect(harness.objects.has(held)).toBe(true);
  });

  it('a held path beside a new one ([held, new]): the action removes nothing; the attempt’s own release then removes only the new upload', async () => {
    const fresh = kidPath(UUID2, 'new.jpg');
    store(fresh, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
    const inserted = recordInserts();
    expect(await submit([held, fresh])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(inserted).toEqual([]);
    expect(harness.removed).toEqual([]);
    // What the browser does with a refusal (lib/chores/proof-submit): release
    // the attempt's paths, both of them; only the unreferenced one goes.
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [held, fresh])).toEqual([fresh]);
    expect(harness.removed).toEqual([fresh]);
    expect(harness.objects.has(held)).toBe(true);
    expect(harness.objects.has(fresh)).toBe(false);
  });

  it('a retry that resends earlier proof is refused before any row is written, and the proof stays', async () => {
    const inserted = recordInserts({ refuseVerdict: true });
    expect(await submit([held])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(inserted, 'refused at the held check: no row, so no rollback').toEqual([]);
    expect(harness.objects.has(held)).toBe(true);
    expect(harness.removed).toEqual([]);
  });
});

describe('a failure after the row is written rolls it back and releases only what nothing references', () => {
  it('reaches row creation, rolls the row back and removes its own upload', async () => {
    const fresh = kidPath(UUID2, 'retry.jpg');
    store(fresh, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
    // The AI-verdict write, which comes after the submission row, is refused.
    const inserted = recordInserts({ refuseVerdict: true });
    expect(await submit([fresh])).toEqual({ ok: false, error: translate(SOURCE_MESSAGES, 'actions.couldNotSaveTheProof') });
    expect(inserted).toEqual([expect.objectContaining({ media_paths: [fresh], status: 'pending' })]);
    expect(db.table('chore_submissions'), 'the row it wrote is gone').toEqual([]);
    expect(harness.removed).toEqual([fresh]);
  });

  it('the rollback still checks references: a row that came to hold the path by another way keeps it', async () => {
    const fresh = kidPath(UUID2, 'retry.jpg');
    store(fresh, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
    const inserted = recordInserts({ refuseVerdict: true });
    // After the action's held check, a row referencing the path appears that
    // did not come through this action (no submission can, without the claim).
    harness.onInfo = async () => {
      harness.onInfo = null;
      db.seed('chore_submissions', [{ id: 'sub-other', family_id: FAMILY, assignment_id: 'assign-1', member_id: KID, media_paths: [fresh], status: 'parent_review' }]);
    };
    expect((await submit([fresh])).ok).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(db.table('chore_submissions').map((r) => r.id)).toEqual(['sub-other']);
    expect(harness.objects.has(fresh)).toBe(true);
    expect(harness.removed).toEqual([]);
  });
});

describe('a release and a submission of the same path cannot interleave (#984: SELECT, then remove)', () => {
  const P = kidPath(UUID2, 'proof.jpg');
  beforeEach(() => { store(P, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([3]) }); });

  /**
   * The interleaving from the review: A validates P; B, a duplicate's cleanup,
   * reads no reference to P; A records its submission; B removes P. A's
   * validation (its info() on P) starts B, and B, once it reaches its removal,
   * waits for A to finish.
   */
  async function interleave(release: () => Promise<string[]>) {
    let aDone!: () => void;
    const aFinished = new Promise<void>((resolve) => { aDone = resolve; });
    let bAtRemove!: () => void;
    const bReachedRemoveOrEnd = new Promise<void>((resolve) => { bAtRemove = resolve; });
    let b!: Promise<string[]>;
    harness.onRemove = async () => { bAtRemove(); await aFinished; };
    harness.onInfo = async () => {
      harness.onInfo = null;
      b = release().finally(() => bAtRemove());
      await bReachedRemoveOrEnd;
    };
    const a = await submit([P]);
    aDone();
    return { a, b: await b };
  }

  it('control, without the claim (the release reading and removing on its own): the harness loses P from a recorded submission', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { a, b } = await interleave(() => releaseUnreferencedProof(harness.db as never, FAMILY, [P], { claims: unclaimed([P]) }));
    expect(a).toEqual({ ok: true });
    expect(b).toEqual([P]);
    expect(db.table('chore_submissions')[0].media_paths).toEqual([P]);
    expect(harness.objects.has(P), 'the recorded proof is gone').toBe(false);
  });

  it('with the claim: B cannot claim the path A holds, so it keeps P, and A’s submission keeps its proof', async () => {
    const { a, b } = await interleave(() => releaseUnreferencedProof(harness.db as never, FAMILY, [P]));
    expect(a).toEqual({ ok: true });
    expect(b).toEqual([]);
    expect(db.table('chore_submissions')[0].media_paths).toEqual([P]);
    expect(harness.objects.has(P)).toBe(true);
    expect(harness.removed).toEqual([]);
  });

  it('the other order: B holds P first; A is refused and records nothing, and B removes an object nothing references', async () => {
    let a: Awaited<ReturnType<typeof submit>> | null = null;
    // B has claimed P and read no reference; at its removal, A runs whole.
    harness.onRemove = async () => { harness.onRemove = null; a = await submit([P]); };
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [P])).toEqual([P]);
    expect(a).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(db.table('chore_submissions')).toEqual([]);
    expect(harness.objects.has(P)).toBe(false);
  });

  it('two submissions of the same path (a duplicated request): one records it, the other is refused, and P stays', async () => {
    let second: Awaited<ReturnType<typeof submit>> | null = null;
    harness.onInfo = async () => { harness.onInfo = null; second = await submit([P]); };
    expect(await submit([P])).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(db.table('chore_submissions')).toHaveLength(1);
    expect(harness.objects.has(P)).toBe(true);
  });

  it('a claim left by an attempt that stopped holding it: the path is neither recorded nor removed', async () => {
    store(proofClaimPath(P), { contentType: 'text/plain', size: 0 });
    expect(await submit([P])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [P])).toEqual([]);
    expect(harness.objects.has(P)).toBe(true);
    expect(db.table('chore_submissions')).toEqual([]);
    harness.objects.delete(proofClaimPath(P));
  });
});

describe('the reviewer decides only what it saw: anything unseen goes to a parent', () => {
  const a = kidPath(UUID, 'a.jpg');
  const b = kidPath(UUID2, 'b.jpg');
  beforeEach(() => {
    db.table('chores')[0].proof_required = 'before_after';
    db.table('chore_assignments')[0].approved_at = null;
    harness.verdict = 'approve';
  });
  const validation = () => db.table('chore_ai_validations')[0];
  const submission = () => db.table('chore_submissions')[0];
  const bothSeen = () => {
    store(a, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    store(b, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
  };
  /** A photo the reviewer is shown, and a video it is not. */
  const oneUnseen = () => {
    store(a, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    store(b, { contentType: 'video/mp4', size: 10 });
  };

  it('control: both photos seen, an approving verdict stays as the reviewer gave it', async () => {
    bothSeen();
    expect(await submit([a, b])).toEqual({ ok: true });
    expect(harness.reviewed[0]).toHaveLength(2);
    expect(validation()).toMatchObject({ status: 'approved', needs_parent_review: false });
  });

  it('one photo over 5 MB: the verdict is held for a parent', async () => {
    store(a, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    store(b, { contentType: 'image/jpeg', size: 6 * 1024 * 1024, bytes: new Uint8Array([2]) });
    expect(await submit([a, b])).toEqual({ ok: true });
    expect(harness.reviewed[0]).toHaveLength(1);
    expect(validation()).toMatchObject({ needs_parent_review: true });
    expect(submission().status).toBe('parent_review');
  });

  it('one photo that could not be read: the verdict is held for a parent', async () => {
    bothSeen();
    harness.failDownload.add(b);
    expect(await submit([a, b])).toEqual({ ok: true });
    expect(harness.reviewed[0]).toHaveLength(1);
    expect(validation()).toMatchObject({ needs_parent_review: true });
    expect(submission().status).toBe('parent_review');
  });

  it('a video beside a photo: the verdict is held for a parent', async () => {
    oneUnseen();
    expect(await submit([a, b])).toEqual({ ok: true });
    expect(validation()).toMatchObject({ needs_parent_review: true });
    expect(submission().status).toBe('parent_review');
  });

  describe('with auto-approval on (the chore approves at a score of 80)', () => {
    beforeEach(() => { db.table('chores')[0].auto_approve_score = 80; });

    it('control: everything seen and approved at 95 is approved and paid without a parent', async () => {
      bothSeen();
      expect(await submit([a, b])).toEqual({ ok: true });
      expect(submission().status).toBe('approved');
      expect(db.table('chore_assignments')[0].status).toBe('approved');
      expect(harness.rewarded).toBe(1);
    });

    it('a video the reviewer never saw: the same verdict is not approved or paid; a parent reviews it', async () => {
      oneUnseen();
      expect(await submit([a, b])).toEqual({ ok: true });
      expect(submission().status).toBe('parent_review');
      expect(db.table('chore_assignments')[0].status).toBe('submitted');
      expect(harness.rewarded).toBe(0);
    });
  });

  describe('a verdict against the child', () => {
    it('control: everything seen and rejected stays rejected', async () => {
      harness.verdict = 'reject';
      bothSeen();
      expect(await submit([a, b])).toEqual({ ok: true });
      expect(submission().status).toBe('rejected');
      expect(validation()).toMatchObject({ status: 'rejected', needs_parent_review: false });
    });

    it('rejected on part of the proof: not rejected, a parent reviews the whole of it (it is in their queue)', async () => {
      harness.verdict = 'reject';
      oneUnseen();
      expect(await submit([a, b])).toEqual({ ok: true });
      // 'parent_review' is one of the statuses the parent's queue lists
      // (app/(app)/missions/page.tsx REVIEW_STATUSES); 'rejected' is not.
      expect(submission().status).toBe('parent_review');
      expect(validation()).toMatchObject({ status: 'rejected', needs_parent_review: true });
      expect(db.table('chore_assignments')[0].status).toBe('submitted');
    });

    it('needs improvement on part of the proof: a parent reviews the whole of it', async () => {
      harness.verdict = 'improve';
      oneUnseen();
      expect(await submit([a, b])).toEqual({ ok: true });
      expect(submission().status).toBe('parent_review');
    });
  });
});

describe('the form sends paths, never the files', () => {
  const form = readFileSync('app/(app)/kids/submit/[assignmentId]/submit-form.tsx', 'utf8');
  const attempt = readFileSync('lib/chores/proof-submit.ts', 'utf8');
  it('uploads through the attempt, which appends only each stored path', () => {
    expect(form).toMatch(/submitProofAttempt\(/);
    expect(form).toMatch(/client\.storage\.from\(PROOF_BUCKET\)\.upload\(path, file/);
    expect(attempt).toMatch(/form\.append\('media_path', path\)/);
  });
  it('does not hand the form element’s own FormData (which carries the files) to the action', () => {
    expect(form).not.toMatch(/submitProofAction\(\s*new FormData\(/);
    expect(form).not.toMatch(/submitProofAction\(form\)/);
    expect(form).toMatch(/submit: \(fd\) => submitProofAction\(fd\)/);
  });
  it('releases uploads only through the reference-checked helper', () => {
    expect(form).toMatch(/release: \(paths\) => releaseUnreferencedProof\(client, familyId, paths\)/);
    expect(form).not.toMatch(/\.remove\(/);
  });
});

describe('a removal with no answer to rely on keeps its claim (#984: a delete that lands late)', () => {
  const P = kidPath(UUID2, 'proof.jpg');
  beforeEach(() => {
    store(P, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([3]) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** The next removal of a proof object is sent and its answer lost; the delete itself lands at `land()`. */
  function lostDelete() {
    let pending: string[] = [];
    harness.onRemove = async (paths) => {
      harness.onRemove = null;
      pending = [...paths];
      throw new Error('connection reset');
    };
    return () => { for (const path of pending) harness.objects.delete(path); };
  }

  it('control: had the claim been let go, the late delete takes P from the submission recorded meanwhile', async () => {
    const land = lostDelete();
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [P])).toEqual([]);
    // What letting go of every claim used to do, whatever the removal's outcome.
    harness.objects.delete(proofClaimPath(P));
    expect(await submit([P])).toEqual({ ok: true });
    land();
    expect(db.table('chore_submissions')[0].media_paths).toEqual([P]);
    expect(harness.objects.has(P), 'the recorded proof is gone').toBe(false);
  });

  it('a release whose removal went unanswered keeps the claim: P cannot be recorded, so the late delete costs no submission', async () => {
    const land = lostDelete();
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [P])).toEqual([]);
    expect(harness.objects.has(proofClaimPath(P)), 'the claim is kept').toBe(true);
    expect(await submit([P])).toEqual({ ok: false, error: UPLOAD_FAILED });
    land();
    expect(db.table('chore_submissions')).toEqual([]);
    harness.objects.delete(proofClaimPath(P));
  });

  it('the action’s own cleanup, unanswered, is kept through its finally: a refused path stays claimed', async () => {
    store(P, { contentType: 'image/svg+xml', size: 10 });
    const land = lostDelete();
    expect(await submit([P])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(harness.objects.has(proofClaimPath(P)), 'kept past the action’s finally').toBe(true);
    land();
    expect(await submit([P])).toEqual({ ok: false, error: UPLOAD_FAILED });
    harness.objects.delete(proofClaimPath(P));
  });

  it('a rollback whose removal went unanswered keeps the claims of everything that removal covered', async () => {
    const Q = kidPath(UUID, 'other.jpg');
    store(Q, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([4]) });
    const inserted = recordInserts({ refuseVerdict: true });
    let pending: string[] = [];
    harness.onRemove = async (paths) => {
      harness.onRemove = null;
      pending = paths.filter((p) => p === P);
      // Q's removal is answered; P's goes unanswered.
      for (const p of paths.filter((x) => x !== P)) harness.objects.delete(p);
      if (pending.length) throw new Error('connection reset');
    };
    expect(await submit([P, Q])).toEqual({ ok: false, error: translate(SOURCE_MESSAGES, 'actions.couldNotSaveTheProof') });
    expect(inserted).toHaveLength(1);
    expect(db.table('chore_submissions')).toEqual([]);
    // One removal call for both: unanswered, so both are kept.
    expect(harness.objects.has(proofClaimPath(P))).toBe(true);
    expect(harness.objects.has(proofClaimPath(Q))).toBe(true);
    harness.objects.delete(proofClaimPath(P));
    harness.objects.delete(proofClaimPath(Q));
  });

  it('an answered refusal from Storage is not a reliable answer either: the claim is kept', async () => {
    harness.onRemove = async () => { harness.onRemove = null; return { data: null, error: { statusCode: '504', message: 'Gateway Timeout' } }; };
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [P])).toEqual([]);
    expect(harness.objects.has(proofClaimPath(P))).toBe(true);
    harness.objects.delete(proofClaimPath(P));
  });

  it('a removal that is answered lets go of the claim, as before', async () => {
    expect(await releaseUnreferencedProof(harness.db as never, FAMILY, [P])).toEqual([P]);
    expect(harness.objects.has(proofClaimPath(P))).toBe(false);
    expect(harness.objects.has(P)).toBe(false);
  });
});
