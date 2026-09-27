// SRV-001 l3 — a template save that fails does not leave the page type with no
// default.
//
// Marking a marketing template "default for this type" clears the current
// default first — 0237's uq_mkt_default_template_per_type refuses a second
// active one — and then writes the new row, in a separate request. When that
// second request failed, the page type had NO default: nothing on the page
// said "Used for generation" and every regeneration of that type's public
// pages fell back to the generic prompt until someone re-ticked a box.
//
// The action now remembers which template was the default and, if the save
// fails, gives it back. (Only both writes failing is left, and an atomic RPC
// would close that; it is recorded, not faked here.)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin-1', actorEmail: 'admin@example.test' }),
  logMarketingAudit: async () => {},
  marketingActionFailure: (operation: string, error: unknown) => {
    throw new Error(`Could not ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  },
}));

const { saveMarketingTemplate } = await import('@/app/(app)/admin/marketing/platform/actions');

let db: InMemorySupabase;
const templates = () => db.table('marketing_content_templates') as { id: string; is_default: boolean; name: string }[];
const defaults = () => templates().filter((t) => t.is_default).map((t) => t.id);

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Let the clear through, then fail the write that was to replace it. */
function failTheSave() {
  const from = db.from.bind(db);
  let updates = 0;
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    const q = from(table);
    if (table !== 'marketing_content_templates') return q;
    const update = q.update.bind(q);
    const insert = q.insert.bind(q);
    return Object.assign(q, {
      update: (...args: Parameters<typeof update>) => {
        updates += 1;
        // 1st update: the clear. 2nd: the save (fails). 3rd: the restore.
        if (updates === 2) return Object.assign(update(...args), { maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'connection reset' } }) });
        return update(...args);
      },
      insert: (...args: Parameters<typeof insert>) => Object.assign(insert(...args), {
        maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'connection reset' } }),
      }),
    });
  }) as typeof db.from);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('marketing_content_templates', [
    { id: 'tpl-current', name: 'Current default', page_type: 'feature', status: 'active', is_default: true, instructions: 'a', defaults: {} },
    { id: 'tpl-new', name: 'New one', page_type: 'feature', status: 'active', is_default: false, instructions: 'b', defaults: {} },
  ]);
  state.db = db;
});

describe('making a template the default', () => {
  it('works, and leaves exactly one default', async () => {
    await saveMarketingTemplate(form({ id: 'tpl-new', name: 'New one', page_type: 'feature', instructions: 'b', is_default: 'on' }));
    expect(defaults()).toEqual(['tpl-new']);
  });

  it('gives the previous default back when the save that was to replace it fails', async () => {
    failTheSave();
    await expect(saveMarketingTemplate(form({ id: 'tpl-new', name: 'New one', page_type: 'feature', instructions: 'b', is_default: 'on' })))
      .rejects.toThrow('Could not save the marketing template');
    vi.restoreAllMocks();
    expect(defaults()).toEqual(['tpl-current']);
  });

  it('does the same for a NEW template whose insert fails', async () => {
    failTheSave();
    await expect(saveMarketingTemplate(form({ name: 'Brand new', page_type: 'feature', instructions: 'c', is_default: 'on' })))
      .rejects.toThrow('Could not save the marketing template');
    vi.restoreAllMocks();
    expect(defaults()).toEqual(['tpl-current']);
  });
});
