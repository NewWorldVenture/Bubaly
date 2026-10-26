import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { change, click, form, nodes, render, submit, text } from './helpers/module-harness';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetHookSlots } from './helpers/hook-slots';
import { isManager } from '@/lib/constants/roles';
import * as sensitivity from '@/lib/documents/sensitivity';
import * as translations from '@/lib/documents/sensitive-translations';

// The Documents folder box suggests "School, Finances, Vacation 2025" — in
// Dutch, "School, Financiën, Vakantie 2025". "Finances" is adults-only; the
// classifier read only ASCII and only English, so "Financiën" was an ordinary
// folder. Once folder names with accents could be stored (09f3c1640), a teen's
// "Financiën" upload succeeded as an ordinary row every child could read, while
// the same teen's "Finances" was refused before the upload. German "Finanzen",
// Spanish "Finanzas" and French "Santé" were already ordinary.
//
// Owner review 6353951568 on #1082, finding 1. What this pins:
//   1. every sensitive category label the app ships, in all 7 catalogues, is
//      sensitive to the classifier — derived from the catalogues, not listed by
//      hand, and every localized word the classifier holds comes from them;
//   2. the folder examples the app shows classify the same in every language;
//   3. through the real Documents and Files hub uploads: a teen is refused a
//      sensitive folder in any language before the bytes move, a parent's
//      upload lands where the DATABASE withholds it from a child too, and an
//      ordinary folder (Unicode included) uploads for both.
//
// The database's own rule (`public.is_sensitive_document`, 0312) reads the
// ASCII English vocabulary only, so a localized sensitive row is filed with
// `is_secure`, which the database does honour. Teaching the SQL rule the
// translations is a schema change and is not made here.

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const catalogue = (locale: string): Record<string, string> => JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8'));
const CATALOGUES = Object.fromEntries(LOCALES.map((locale) => [locale, catalogue(locale)]));

/** The database's category rule, written out again here from 0312: ASCII, English, one trailing "s". */
function databaseSaysSensitive(row: { is_secure?: unknown; category?: unknown }): boolean {
  if (row.is_secure === true) return true;
  const cat = String(row.category ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!cat) return false;
  if (sensitivity.SENSITIVE_PHRASES.some((phrase) => cat.includes(phrase))) return true;
  return cat.split(' ').some((token) => sensitivity.SENSITIVE_CATEGORIES.has(token)
    || (token.length > 1 && token.endsWith('s') && sensitivity.SENSITIVE_CATEGORIES.has(token.slice(0, -1))));
}

/** Lowercase, accents dropped, non-alphanumerics to one space. */
const fold = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Every one-word English label the catalogue ships that the English rule calls
 * sensitive ("Finances", "Medical", "Passport", "Insurance" …), with what each
 * other catalogue calls it.
 */
function sensitiveLabels() {
  const en = CATALOGUES['en-US'];
  return Object.entries(en)
    .filter(([, value]) => typeof value === 'string' && /^[A-Za-z]+$/.test(value.trim()) && databaseSaysSensitive({ category: value }))
    .flatMap(([key, english]) => LOCALES.slice(1).map((locale) => ({ key, english, locale, value: CATALOGUES[locale][key] })))
    .filter((entry) => typeof entry.value === 'string' && entry.value.trim() !== '');
}

describe('a sensitive category is sensitive in every language the app speaks', () => {
  const labels = sensitiveLabels();
  const excluded = new Set<string>((translations as { SENSITIVE_TRANSLATION_EXCLUSIONS?: readonly string[] }).SENSITIVE_TRANSLATION_EXCLUSIONS ?? []);

  it('finds the labels it derives from (the catalogue has not lost them)', () => {
    expect(new Set(labels.map((label) => label.key)).size).toBeGreaterThan(30);
    expect(labels.some((label) => label.locale === 'nl-NL' && label.value === 'Financiën')).toBe(true);
  });

  it('classifies every translation of a sensitive label as sensitive', () => {
    const missed = labels
      .filter((label) => !excluded.has(fold(label.value)))
      .filter((label) => !sensitivity.isSensitiveCategory(label.value))
      .map((label) => `${label.locale} ${label.key} "${label.value}" (${label.english})`);
    expect(missed, 'add these, folded, to lib/documents/sensitive-translations.ts').toEqual([]);
  });

  it('holds no localized word or phrase the catalogues do not give it', () => {
    const given = new Set(labels.map((label) => fold(label.value)));
    const words = (translations as { SENSITIVE_TRANSLATIONS?: ReadonlySet<string> }).SENSITIVE_TRANSLATIONS ?? new Set<string>();
    const phrases = (translations as { SENSITIVE_TRANSLATED_PHRASES?: readonly string[] }).SENSITIVE_TRANSLATED_PHRASES ?? [];
    expect([...words, ...phrases].filter((entry) => !given.has(entry))).toEqual([]);
    expect(words.size).toBeGreaterThan(40);
  });

  it('every exclusion is a real translation that also names something ordinary, and stays ordinary', () => {
    const given = new Set(labels.map((label) => fold(label.value)));
    for (const word of excluded) {
      expect(given.has(word), `${word} is not a catalogue translation`).toBe(true);
      expect(sensitivity.isSensitiveCategory(word)).toBe(false);
    }
  });

  it.each(['documents.eGSchoolFinancesVacation2025', 'filesHub.eGTravelSchoolFinances'])(
    'the folder examples in %s classify the same in every language as in English',
    (key) => {
      const shape = (locale: string) => CATALOGUES[locale][key].split(',').map((item) => sensitivity.isSensitiveCategory(item));
      const english = shape('en-US');
      expect(english).toContain(true);
      for (const locale of LOCALES) expect(shape(locale), `${locale}: ${CATALOGUES[locale][key]}`).toEqual(english);
    },
  );

  it('folds accents for the English words too, and keeps ordinary words ordinary', () => {
    for (const folder of ['Médical', 'Financiën', 'Santé', 'Finanzen', 'Versicherungen', 'Reisepässe', 'Pièce d’identité', 'Carta de condução']) {
      expect(sensitivity.isSensitiveCategory(folder), folder).toBe(true);
    }
    for (const folder of ['École', 'Vakantie 2025', 'Schule', 'Fotos 📷', 'Kids’ stuff', 'Anlagen', 'Reforma cocina', 'Kids']) {
      expect(sensitivity.isSensitiveCategory(folder), folder).toBe(false);
    }
  });
});

// ── through the real uploads ─────────────────────────────────────────────────

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const bucket = vi.hoisted(() => ({ uploads: [] as string[], role: 'parent' }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return {
    createClient: () => {
      const client = clientFor(h);
      return {
        ...client,
        // 0266's insert policy, keyed on what the database itself reads.
        from: (table: string) => {
          const builder = client.from(table) as Record<string, (...args: unknown[]) => unknown>;
          if (table !== 'documents') return builder;
          return new Proxy(builder, {
            get: (target, property) => (property === 'insert'
              ? (row: Record<string, unknown>) => (databaseSaysSensitive(row) && !isManager(bucket.role as never)
                ? Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "documents"' } })
                : target.insert(row))
              : Reflect.get(target, property)),
          });
        },
        storage: {
          from: (name: string) => {
            const real = client.storage.from(name);
            return { ...real, upload: async (path: string) => { bucket.uploads.push(path); return real.upload(path); } };
          },
        },
      };
    },
  };
});
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { DocumentsModule } = await import('@/components/modules/documents-module');
const { FilesHubModule } = await import('@/components/modules/files-hub-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = { documents: [] }; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  bucket.uploads = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const scan = () => new File(['scan'], 'statement.pdf', { type: 'application/pdf' });
const stored = () => [...(h.storage.objects.get('documents') ?? [])];

async function uploadInDocuments(role: string, folder: string) {
  bucket.role = role; (h.app as Record<string, unknown>).role = role;
  const element = () => createElement(DocumentsModule);
  let tree = render(h.hooks, element());
  change(nodes(tree).find((node) => node.type === 'input' && node.props.capture === 'environment')!, [scan()]);
  tree = render(h.hooks, element());
  change(nodes(tree).find((node) => node.type === 'input' && node.props.list === 'folder-options')!, folder);
  tree = render(h.hooks, element());
  const buttons = nodes(tree).filter((node) => node.type === 'button' && text(node).trim() === t('documents.uploadFile'));
  await click(buttons[buttons.length - 1]);
}

async function uploadInFilesHub(role: string, folder: string) {
  bucket.role = role; (h.app as Record<string, unknown>).role = role;
  const element = () => createElement(FilesHubModule, { view: 'shared' });
  let tree = render(h.hooks, element());
  await click(nodes(tree).find((node) => node.type === 'button' && typeof node.props.onClick === 'function' && text(node).trim() === t('filesHub.upload'))!);
  tree = render(h.hooks, element());
  const fields = nodes(form(tree));
  change(fields.find((node) => node.type === 'input' && node.props.type === 'file')!, [scan()]);
  change(fields.find((node) => node.type === 'input' && node.props.placeholder === t('documents.eGPassportEmmaPdf'))!, 'Statement');
  change(fields.find((node) => node.type === 'input' && node.props.placeholder === t('filesHub.eGTravelSchoolFinances'))!, folder);
  tree = render(h.hooks, element());
  await submit(form(tree));
}

const SENSITIVE = [['English', 'Finances'], ['Dutch', 'Financiën'], ['German', 'Versicherung'], ['French', 'Santé']] as const;
const ORDINARY = [['English', 'School'], ['Dutch', 'Vakantie 2025'], ['French', 'École']] as const;
const UPLOADS = [['Documents', uploadInDocuments], ['the Files hub', uploadInFilesHub]] as const;

describe.each(UPLOADS)('%s upload, in every language', (_surface, upload) => {
  it.each(SENSITIVE)('a teen filing the %s sensitive folder "%s" is refused before the file moves', async (_language, folder) => {
    await upload('teen', folder);

    expect(h.toasts.error).toEqual([t('filesHubModule.refuseSensitive', { category: folder.toLowerCase() })]);
    expect(bucket.uploads).toEqual([]);
    expect(db.table('documents')).toEqual([]);
  });

  it.each(SENSITIVE)('a parent files the %s sensitive folder "%s" where the database keeps it from a child', async (language, folder) => {
    await upload('parent', folder);

    expect(h.toasts.error).toEqual([]);
    const rows = db.table('documents');
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe(folder);
    expect(databaseSaysSensitive(rows[0]), 'a child could read this row').toBe(true);
    // Raised to the Vault flag only where the database's English rule cannot
    // see the folder; an English one stays where it was filed.
    expect(rows[0].is_secure).toBe(language !== 'English');
    expect(stored()).toEqual([rows[0].storage_path]);
  });

  it.each(ORDINARY.flatMap(([language, folder]) => [['parent', language, folder], ['teen', language, folder]]))(
    'a %s files the %s ordinary folder "%s" as an ordinary file',
    async (role, _language, folder) => {
      await upload(role, folder);

      expect(h.toasts.error).toEqual([]);
      const rows = db.table('documents');
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe(folder);
      expect(databaseSaysSensitive(rows[0]), 'an ordinary file was hidden from the family').toBe(false);
      expect(stored()).toEqual([rows[0].storage_path]);
    },
  );
});
