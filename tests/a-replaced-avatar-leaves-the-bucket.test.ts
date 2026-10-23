// A replaced or removed profile photo leaves the public bucket.
//
// AvatarPicker uploads every avatar as a NEW object `<userId>/<uuid>.<ext>` in
// the PUBLIC `avatars` bucket, and its "Remove" only blanks the field.
// saveUserProfile overwrote profiles.avatar_url without reading the previous
// value or touching storage; lib/storage/avatars.ts said it outright: "every
// avatar a user ever uploaded ... they are never deleted". The bucket is public
// and the URL was rendered app-wide (cached, logged), so each superseded face
// photo stayed fetchable by anyone who held its URL, for ever. The profile
// write now reads the previous URL first and, once the row is written, removes
// the old object — only when it is the caller's OWN folder (a crafted row could
// name another's), and confirmed gone (removeConfirmed). A removal that fails is
// logged and the profile write stands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ svc: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.svc }));

const { avatarObjectPathFor } = await import('@/lib/storage/avatars');
const { saveUserProfile } = await import('@/lib/server/profiles');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const publicUrl = (path: string) => `https://proj.supabase.co/storage/v1/object/public/avatars/${path}`;
const OLD = publicUrl(`${USER}/a1b2c3.png`);
const NEW = publicUrl(`${USER}/d4e5f6.webp`);

describe('avatarObjectPathFor: only the caller\'s own object', () => {
  it('names the object under the caller\'s folder', () => {
    expect(avatarObjectPathFor(USER, OLD)).toBe(`${USER}/a1b2c3.png`);
    expect(avatarObjectPathFor(USER, publicUrl(`${USER}/with%20space.png`))).toBe(`${USER}/with space.png`);
  });

  it('answers null for another folder, a nested path, an external picture, a data URI, or nothing', () => {
    expect(avatarObjectPathFor(USER, publicUrl(`${OTHER}/theirs.png`))).toBeNull();
    expect(avatarObjectPathFor(USER, publicUrl(`${USER}/../${OTHER}/theirs.png`))).toBeNull();
    expect(avatarObjectPathFor(USER, publicUrl(`${USER}/deeper/x.png`))).toBeNull();
    expect(avatarObjectPathFor(USER, 'https://cdn.example/photos/me.png')).toBeNull();
    expect(avatarObjectPathFor(USER, 'https://proj.supabase.co/storage/v1/object/public/family-media/fam/x.png')).toBeNull();
    expect(avatarObjectPathFor(USER, 'data:image/png;base64,AAAA')).toBeNull();
    expect(avatarObjectPathFor(USER, '')).toBeNull();
    expect(avatarObjectPathFor(USER, null)).toBeNull();
    expect(avatarObjectPathFor('', OLD)).toBeNull();
  });
});

describe('saveUserProfile', () => {
  let db: InMemorySupabase;
  let objects: Set<string>;
  let refused: Set<string>;
  let removed: string[][];
  let errors: unknown[][];

  const bucket = () => ({
    remove: async (paths: string[]) => {
      removed.push(paths);
      const gone = paths.filter((path) => !refused.has(path) && objects.delete(path));
      return { data: gone.map((name) => ({ name })), error: null };
    },
    list: async (folder: string, options?: { search?: string }) => ({
      data: [...objects].filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1)).filter((n) => !options?.search || n.startsWith(options.search)).map((name) => ({ name })),
      error: null,
    }),
  });
  const profile = () => db.table('profiles').find((row) => row.id === USER)!;
  const save = (avatarUrl?: string | null) => saveUserProfile(USER, { firstName: 'Jo', lastName: 'Rivera', phone: '+15555550100', ...(avatarUrl === undefined ? {} : { avatarUrl }) });

  beforeEach(() => {
    removed = [];
    errors = [];
    refused = new Set();
    objects = new Set([`${USER}/a1b2c3.png`, `${USER}/d4e5f6.webp`, `${OTHER}/theirs.png`]);
    db = createInMemorySupabase();
    db.seed('profiles', [{ id: USER, full_name: 'Jo Rivera', display_name: 'Jo', phone: '+15555550100', avatar_url: OLD }]);
    db.seed('family_members', [{ id: 'm1', family_id: 'fam-1', user_id: USER, display_name: 'Jo' }]);
    state.svc = Object.assign(db, { storage: { from: (name: string) => { expect(name).toBe('avatars'); return bucket(); } } });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('replacing the photo removes the superseded object once the row names the new one', async () => {
    expect(await save(NEW)).toEqual({ ok: true });
    expect(profile().avatar_url).toBe(NEW);
    expect(removed).toEqual([[`${USER}/a1b2c3.png`]]);
    expect(objects.has(`${USER}/a1b2c3.png`)).toBe(false);
    expect(objects.has(`${USER}/d4e5f6.webp`)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('removing the photo removes the object too', async () => {
    expect(await save('')).toEqual({ ok: true });
    expect(profile().avatar_url).toBeNull();
    expect(objects.has(`${USER}/a1b2c3.png`)).toBe(false);
  });

  it('saving the same photo, or a save that does not touch the photo, removes nothing', async () => {
    expect(await save(OLD)).toEqual({ ok: true });
    expect(await save()).toEqual({ ok: true });
    expect(removed).toEqual([]);
    expect(profile().avatar_url).toBe(OLD);
  });

  it('never removes an object outside the caller\'s own folder, whatever the row named', async () => {
    profile().avatar_url = publicUrl(`${OTHER}/theirs.png`);
    expect(await save(NEW)).toEqual({ ok: true });
    profile().avatar_url = 'https://cdn.example/photos/me.png';
    expect(await save(OLD)).toEqual({ ok: true });
    expect(removed).toEqual([]);
    expect(objects.has(`${OTHER}/theirs.png`)).toBe(true);
  });

  it('a removal the bucket refused is logged with its path, and the profile write stands', async () => {
    refused.add(`${USER}/a1b2c3.png`);
    expect(await save(NEW)).toEqual({ ok: true });
    expect(profile().avatar_url).toBe(NEW);
    expect(removed).toEqual([[`${USER}/a1b2c3.png`]]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain('previous avatar was not removed');
    expect(errors[0][1]).toMatchObject({ path: `${USER}/a1b2c3.png` });
  });

  it('a profile write that failed removes nothing', async () => {
    const broken = Object.assign(createInMemorySupabase(), { storage: { from: () => bucket() } });
    const realFrom = broken.from.bind(broken);
    broken.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'profiles') return builder;
      const chain = new Proxy(builder, {
        get(target, prop) {
          if (prop === 'upsert') return () => ({ then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: '42501', message: 'permission denied' }, count: null }) });
          return Reflect.get(target, prop);
        },
      });
      return chain;
    }) as typeof broken.from;
    broken.seed('profiles', [{ id: USER, avatar_url: OLD }]);
    state.svc = broken;
    const res = await save(NEW);
    expect(res.ok).toBe(false);
    expect(removed).toEqual([]);
  });
});
