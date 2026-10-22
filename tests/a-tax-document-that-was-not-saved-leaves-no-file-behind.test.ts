import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { formatCents } from '@/lib/wallet/ledger';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, form, nodes, render, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// S9 — the Tax Vault uploaded the W-2 first and inserted its row second, and
// when the insert failed it returned the error and left the file. An amount of
// $21,474,836.48 or more (int4 `amount_cents`, 0077), a tax year past int4, a
// member removed while the list was open, a dropped connection: each left the
// tax document's bytes under {familyId}/tax/{year}/ with no row — invisible in
// the vault, impossible to delete from it, and a retry stored a second copy.
// documents-module and lib/documents/upload already discard the object; this
// module did not.
//
// Each case drives the REAL module against an in-memory database and a
// documents bucket.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { TaxVaultModule } = await import('@/components/modules/tax-vault-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(TaxVaultModule));
const bucket = () => [...(h.storage.objects.get('documents') ?? [])];

const field = (tree: ReactNode, match: (node: Node) => boolean): Node => {
  const found = nodes(form(tree)).find(match);
  if (!found) throw new Error('no such field');
  return found;
};

/** Open "Add document", fill it in the way a parent would, and submit. */
async function fileA(doc: { name: string; amount?: string; year?: string }) {
  await click(byName(screen(), t('taxVault.addDocument')));
  (field(screen(), (n) => n.type === 'input' && n.props.placeholder === t('taxVault.2025W2AcmeCorp')).props.onChange as (e: unknown) => void)({ target: { value: doc.name } });
  if (doc.amount) (field(screen(), (n) => n.type === 'input' && n.props.step === '0.01').props.onChange as (e: unknown) => void)({ target: { value: doc.amount } });
  if (doc.year) (field(screen(), (n) => n.type === 'input' && n.props.type === 'number' && n.props.step === undefined).props.onChange as (e: unknown) => void)({ target: { value: doc.year } });
  (field(screen(), (n) => n.type === 'input' && n.props.type === 'file').props.onChange as (e: unknown) => void)({ target: { files: [{ name: 'w2.pdf', size: 4096, type: 'application/pdf' }] } });
  await settle();
  await submit(form(screen()));
}

describe('a tax document whose row was not saved leaves no file in the bucket', () => {
  it('the insert is refused: the uploaded W-2 is removed and the refusal is shown', async () => {
    h.fault = (table, calls) => (table === 'tax_documents' && calls.includes('insert')
      ? { code: '23503', message: 'insert or update on table "tax_documents" violates foreign key constraint' } : null);

    await fileA({ name: '2025 W-2 Acme', amount: '1200' });

    expect(db.table('tax_documents')).toEqual([]);
    expect(bucket()).toEqual([]);
    expect(h.toasts.error.length).toBeGreaterThan(0);
    expect(h.toasts.success).not.toContain(t('taxVaultModule.documentSaved'));
  });

  it('an amount past what the column holds is refused before anything is uploaded', async () => {
    await fileA({ name: 'Settlement', amount: '21474836.48' });

    expect(bucket()).toEqual([]);
    expect(db.table('tax_documents')).toEqual([]);
    expect(h.toasts.error).toContain(t('taxVaultModule.amountTooLarge', { max: formatCents(2_147_483_647, 'USD', 'en-US') }));
  });

  it('a tax year past what the column holds is refused before anything is uploaded', async () => {
    await fileA({ name: 'Old return', year: '99999999999' });

    expect(bucket()).toEqual([]);
    expect(db.table('tax_documents')).toEqual([]);
    expect(h.toasts.error.some((message) => message.startsWith('Enter a tax year'))).toBe(true);
  });

  it('a document that saves keeps its file, confirmed by the row it wrote', async () => {
    await fileA({ name: '2025 W-2 Acme', amount: '1200' });

    expect(db.table('tax_documents')).toHaveLength(1);
    expect(bucket()).toEqual([db.table('tax_documents')[0].storage_path]);
    expect(h.toasts.success).toContain(t('taxVaultModule.documentSaved'));
  });
});
