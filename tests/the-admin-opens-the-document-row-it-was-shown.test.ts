import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_ERROR_ENGLISH } from '@/lib/supabase/errors';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// The admin console's "View" on a family document (admin/content) signs a
// link with the SERVICE ROLE, which signs any object in the bucket it is
// handed. adminGetDocumentUrlAction took that object's path from the browser:
// whatever path a request named, of any family, came back as a working link.
// adminDeleteDocumentAction beside it already reads the row's own path by id.
//
// It now takes the document's id, reads the row, and signs the row's own path:
//   - a missing row, or a row whose path is no longer the one the screen
//     listed, is refused and nothing is signed;
//   - a row whose path lies outside its own family's folder (nothing ties the
//     two together: the held 0499's recorded lead) is refused too.

const state = vi.hoisted(() => ({
  db: null as unknown, signed: [] as string[], canonicalReadError: false,
  admin: vi.fn<() => Promise<boolean>>(), assurance: vi.fn<() => Promise<{ ok: boolean }>>(),
  client: vi.fn(), read: vi.fn(),
  sign: vi.fn<(path: string, ttl: number) => Promise<{ data: { signedUrl: string }; error: null }>>(),
  forbidden: vi.fn((name: string): never => { throw new Error('Forbidden signer-proof boundary: ' + name); }),
}));

vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: state.admin, getUser: () => state.forbidden('Auth user read') }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: state.assurance }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => state.forbidden('server client'), createServiceClient: state.client }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => state.forbidden('SDK construction') }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => state.forbidden('SSR construction'), createBrowserClient: () => state.forbidden('browser client') }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: () => state.forbidden('audit write') }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://signer-proof.invalid', sendReactEmail: () => state.forbidden('email') }));
vi.mock('@/lib/stripe', () => ({ stripeFromKey: () => state.forbidden('Stripe') }));
vi.mock('@/lib/stripe/settings', () => ({ readStripeSettings: () => state.forbidden('Stripe settings'), effectiveSecretKey: () => state.forbidden('Stripe key') }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: () => state.forbidden('provider'), isAIConfigured: () => state.forbidden('provider configuration') }));
vi.mock('next/cache', () => ({ revalidatePath: () => state.forbidden('cache invalidation') }));

const importFetchGuard = vi.fn(() => state.forbidden('import-time fetch'));
vi.stubGlobal('fetch', importFetchGuard);
const { adminGetDocumentUrlAction } = await import('@/app/(app)/admin/actions');
const importBoundaryCalls = { fetch: [...importFetchGuard.mock.calls], forbidden: [...state.forbidden.mock.calls] };

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const PASSPORT = `${FAMILY_A}/vault/1700000000000-passport.pdf`;
const OTHER_FAMILYS_WILL = `${FAMILY_B}/legal/1700000000001-will.pdf`;

let db: InMemorySupabase;

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.admin.mockResolvedValue(true); state.assurance.mockResolvedValue({ ok: true });
  state.canonicalReadError = false; state.signed = [];
  fetchGuard = vi.fn(() => state.forbidden('runtime fetch')); vi.stubGlobal('fetch', fetchGuard);
  db = createInMemorySupabase();
  db.seed('documents', [
    { id: 'doc-passport', family_id: FAMILY_A, title: 'Passport', storage_path: PASSPORT },
    // A row of family A that names family B's file.
    { id: 'doc-planted', family_id: FAMILY_A, title: 'Planted', storage_path: OTHER_FAMILYS_WILL },
  ]);
  state.sign.mockImplementation(async (path, _ttl) => {
    state.signed.push(path);
    return { data: { signedUrl: 'https://signed.invalid/' + path }, error: null };
  });
  const storage = { from: (bucket: string) => {
    if (bucket !== 'documents') state.forbidden('unknown Storage bucket');
    return { createSignedUrl: state.sign };
  } };
  const from = (table: string) => {
    if (table !== 'documents') state.forbidden('unknown table ' + table);
    const builder = db.from(table), filters: [string, unknown][] = [];
    let columns = '';
    const proxy: typeof builder = new Proxy(builder, { get(object, property) {
      if (property === 'select') return (value: string) => {
        if (value !== 'family_id, storage_path') state.forbidden('unexpected projection');
        columns = value; object.select(value); return proxy;
      };
      if (property === 'eq') return (key: string, value: unknown) => {
        if (key !== 'id' || typeof value !== 'string') state.forbidden('unexpected document filter');
        filters.push([key, value]); object.eq(key, value); return proxy;
      };
      if (property === 'maybeSingle') return () => {
        if (columns !== 'family_id, storage_path' || filters.length !== 1) state.forbidden('incomplete canonical read');
        state.read({ table, columns, filters });
        return state.canonicalReadError
          ? Promise.resolve({ data: null, error: { code: '42501', message: 'Synthetic canonical read refused' } })
          : object.maybeSingle();
      };
      return () => state.forbidden('unexpected query operation ' + String(property));
    } });
    return proxy;
  };
  state.db = { from, storage };
  state.client.mockImplementation(() => state.db);
});

afterEach(() => {
  expect(importBoundaryCalls).toEqual({ fetch: [], forbidden: [] });
  expect(fetchGuard).not.toHaveBeenCalled(); expect(state.forbidden).not.toHaveBeenCalled();
  // The existing successful canonical-path control also pins its short TTL.
  for (const [_path, ttl] of state.sign.mock.calls) expect(ttl).toBe(120);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('the admin opens the document row it was shown', () => {
  it('signs the row’s own path', async () => {
    await expect(adminGetDocumentUrlAction('doc-passport', PASSPORT))
      .resolves.toEqual({ ok: true, data: { url: `https://signed.invalid/${PASSPORT}` } });
    expect(state.signed).toEqual([PASSPORT]);
  });

  it('does not sign a path the browser named that is not the row’s', async () => {
    await expect(adminGetDocumentUrlAction('doc-passport', OTHER_FAMILYS_WILL))
      .resolves.toEqual({ ok: false, error: 'actions.documentNotFound' });
    expect(state.signed).toEqual([]);
  });

  it('does not sign anything for a row that is not there', async () => {
    await expect(adminGetDocumentUrlAction('doc-gone', PASSPORT))
      .resolves.toEqual({ ok: false, error: 'actions.documentNotFound' });
    expect(state.signed).toEqual([]);
  });

  it('does not sign another family’s file through a row that names it', async () => {
    await expect(adminGetDocumentUrlAction('doc-planted', OTHER_FAMILYS_WILL))
      .resolves.toEqual({ ok: false, error: 'actions.couldNotCreateADocument' });
    expect(state.signed).toEqual([]);
  });

  it('the console’s View button sends the row’s id with the path it listed', () => {
    const source = readFileSync('components/admin/document-row-actions.tsx', 'utf8');
    expect(source).toContain('adminGetDocumentUrlAction(documentId, storagePath)');
  });
});


describe('valid-input admin document signing refuses before privileged effects', () => {
  it('checks and refuses a non-admin before assurance, document client or signing', async () => {
    state.admin.mockResolvedValue(false);
    await expect(adminGetDocumentUrlAction('doc-passport', PASSPORT))
      .resolves.toEqual({ ok: false, error: 'actions.notAuthorized' });
    expect(state.admin).toHaveBeenCalledTimes(1);
    expect(state.assurance).not.toHaveBeenCalled();
    expect(state.client).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
    expect(state.sign).not.toHaveBeenCalled(); expect(state.signed).toEqual([]);
  });

  it('checks and refuses a super-admin without step-up before document client or signing', async () => {
    state.assurance.mockResolvedValue({ ok: false });
    await expect(adminGetDocumentUrlAction('doc-passport', PASSPORT))
      .resolves.toEqual({ ok: false, error: 'actions.adminConsoleNeedsYourCode' });
    expect(state.admin).toHaveBeenCalledTimes(1); expect(state.assurance).toHaveBeenCalledTimes(1);
    expect(state.client).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
    expect(state.sign).not.toHaveBeenCalled(); expect(state.signed).toEqual([]);
  });

  it('answers a refused canonical row read without signing any object', async () => {
    state.canonicalReadError = true;
    await expect(adminGetDocumentUrlAction('doc-passport', PASSPORT))
      .resolves.toEqual({ ok: false, error: DB_ERROR_ENGLISH['dbError.permission'] });
    expect(state.admin).toHaveBeenCalledTimes(1); expect(state.assurance).toHaveBeenCalledTimes(1);
    expect(state.client).toHaveBeenCalledTimes(1); expect(state.read).toHaveBeenCalledTimes(1);
    expect(state.read).toHaveBeenCalledWith({ table: 'documents', columns: 'family_id, storage_path', filters: [['id', 'doc-passport']] });
    expect(state.sign).not.toHaveBeenCalled(); expect(state.signed).toEqual([]);
  });
});
