import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  removed: [] as string[],
  reviewed: [] as { media_type: string; data: string }[][],
  approve: false,
  failDownload: new Set<string>(),
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
    // `approve`: the reviewer is satisfied with what it was shown.
    return harness.approve
      ? { status: 'approved', quality_score: 95, confidence: 0.9, recommended_reward_type: 'none',
        recommended_reward_amount: 0, kid_feedback: 'great', parent_summary: 'done', detected_issues: [],
        safety_flags: [], needs_parent_review: false, model: 'test', is_fallback: false }
      : { status: 'needs_review', quality_score: 50, confidence: 0.5, recommended_reward_type: 'none',
        recommended_reward_amount: 0, kid_feedback: 'ok', parent_summary: 'ok', detected_issues: [],
        safety_flags: [], needs_parent_review: true, model: 'test', is_fallback: true };
  },
}));

// The in-memory database, plus the four Storage calls the action makes.
function withStorage(db: InMemorySupabase) {
  const bucket = {
    info: async (path: string) => {
      const o = harness.objects.get(path);
      return o ? { data: { name: path, contentType: o.contentType, size: o.size, metadata: { mimetype: o.contentType, size: o.size } }, error: null }
        : { data: null, error: { message: 'Object not found' } };
    },
    download: async (path: string) => {
      if (harness.failDownload.has(path)) return { data: null, error: { message: 'download failed' } };
      const o = harness.objects.get(path);
      return o?.bytes ? { data: new Blob([o.bytes]), error: null } : { data: null, error: { message: 'Object not found' } };
    },
    remove: async (paths: string[]) => { harness.removed.push(...paths); paths.forEach((p) => harness.objects.delete(p)); return { data: [], error: null }; },
    upload: async () => { throw new Error('the action must not upload proof bytes itself any more'); },
  };
  return new Proxy(db as object, {
    get: (target, prop) => (prop === 'storage' ? { from: (name: string) => { expect(name).toBe('chore-proof'); return bucket; } } : Reflect.get(target, prop)),
  });
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));

const { submitProofAction } = await import('@/app/(app)/missions/actions');
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
  harness.reviewed = [];
  harness.approve = false;
  harness.failDownload = new Set();
  harness.memberId = KID;
  harness.role = 'child';
  db = createInMemorySupabase();
  harness.db = withStorage(db);
  db.seed('chore_assignments', [{ id: 'assign-1', family_id: FAMILY, chore_id: 'chore-1', member_id: KID, status: 'pending' }]);
  db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Make the bed', proof_required: 'photo', auto_approve_score: null }]);
});

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

  it('a held path beside a new one is refused; only the new, unreferenced upload is released', async () => {
    const fresh = kidPath(UUID2, 'new.jpg');
    store(fresh, { contentType: 'image/svg+xml', size: 10 });
    expect(await submit([fresh, fresh])).toEqual({ ok: false, error: UPLOAD_FAILED });
    expect(harness.removed).toEqual([fresh]);
    expect(harness.objects.has(held)).toBe(true);
  });

  it('a later retry that fails after its own row was written removes its own upload, never the earlier proof', async () => {
    const fresh = kidPath(UUID2, 'retry.jpg');
    store(fresh, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
    // Fail the AI-verdict write, which rolls back this attempt's submission row.
    const real = db.from.bind(db);
    harness.db = new Proxy(harness.db as object, {
      get: (target, prop) => (prop === 'from'
        ? (table: string) => (table === 'chore_ai_validations'
          ? { insert: async () => ({ error: { message: 'refused' } }) }
          : real(table))
        : Reflect.get(target, prop)),
    });
    const res = await submit([fresh]);
    expect(res.ok).toBe(false);
    expect(harness.removed).toEqual([fresh]);
    expect(harness.objects.has(held)).toBe(true);
    expect(db.table('chore_submissions').map((r) => r.id)).toEqual(['sub-old']);
  });
});

describe('a retry that resends earlier proof and then fails keeps that proof', () => {
  it('the held object survives a retry whose own row is rolled back', async () => {
    const held = kidPath(UUID, 'old.jpg');
    store(held, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    db.seed('chore_submissions', [{ id: 'sub-old', family_id: FAMILY, assignment_id: 'assign-1', member_id: KID, media_paths: [held], status: 'needs_improvement' }]);
    const real = db.from.bind(db);
    harness.db = new Proxy(harness.db as object, {
      get: (target, prop) => (prop === 'from'
        ? (table: string) => (table === 'chore_ai_validations'
          ? { insert: async () => ({ error: { message: 'refused' } }) }
          : real(table))
        : Reflect.get(target, prop)),
    });
    expect((await submit([held])).ok).toBe(false);
    expect(harness.objects.has(held)).toBe(true);
    expect(harness.removed).toEqual([]);
  });
});

describe('the reviewer approves only what it saw: anything unseen goes to a parent', () => {
  const a = kidPath(UUID, 'a.jpg');
  const b = kidPath(UUID2, 'b.jpg');
  beforeEach(() => {
    db.table('chores')[0].proof_required = 'before_after';
    harness.approve = true;
  });
  const validation = () => db.table('chore_ai_validations')[0];

  it('control: both photos seen, an approving verdict stays as the reviewer gave it', async () => {
    store(a, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    store(b, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
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
    expect(db.table('chore_submissions')[0].status).toBe('parent_review');
  });

  it('one photo that could not be read: the verdict is held for a parent', async () => {
    store(a, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    store(b, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([2]) });
    harness.failDownload.add(b);
    expect(await submit([a, b])).toEqual({ ok: true });
    expect(harness.reviewed[0]).toHaveLength(1);
    expect(validation()).toMatchObject({ needs_parent_review: true });
    expect(db.table('chore_submissions')[0].status).toBe('parent_review');
  });

  it('a video beside a photo: the verdict is held for a parent', async () => {
    store(a, { contentType: 'image/jpeg', size: 10, bytes: new Uint8Array([1]) });
    store(b, { contentType: 'video/mp4', size: 10 });
    expect(await submit([a, b])).toEqual({ ok: true });
    expect(validation()).toMatchObject({ needs_parent_review: true });
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
