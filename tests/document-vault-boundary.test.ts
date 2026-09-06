// 0266: the Secure Vault is a database boundary, not a label the client draws.
//
// The migration and `lib/services/documents` each carry a list of sensitive
// categories. They must be the same list: if SQL knows about `medical` and
// TypeScript does not, the AI layer hands a child a file the database would
// have withheld; if TypeScript knows and SQL does not, the Files hub serves it
// through the anon client and nothing stops that at all. This test is the only
// thing holding the two together.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SENSITIVE_CATEGORIES, isSensitiveCategory } from '@/lib/documents/sensitivity';

const MIGRATION = readFileSync('supabase/migrations/0266_document_vault_boundary.sql', 'utf8');

/** The category list inside `is_sensitive_document`, in SQL's own words. */
function sqlCategories(): string[] {
  const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.is_sensitive_document'));
  const list = fn.slice(fn.indexOf('in ('), fn.indexOf(');'));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('the sensitive-document definition is one definition', () => {
  it('SQL and TypeScript name exactly the same categories', () => {
    expect(sqlCategories()).toEqual([...SENSITIVE_CATEGORIES].sort());
  });

  it('still covers the categories a family would be shocked to leak', () => {
    // A guard against both lists being edited down together.
    for (const category of ['medical', 'legal', 'financial', 'passport', 'bank', 'insurance']) {
      expect(SENSITIVE_CATEGORIES.has(category), `${category} stopped being sensitive`).toBe(true);
      expect(sqlCategories()).toContain(category);
    }
  });
});

describe('every documents policy consults it', () => {
  it.each(['select', 'insert', 'update', 'delete'])('documents_%s is role-aware', (cmd) => {
    const policy = MIGRATION.slice(MIGRATION.indexOf(`create policy documents_${cmd} on public.documents`));
    const body = policy.slice(0, policy.indexOf(';'));
    expect(body).toContain('is_sensitive_document');
    expect(body).toContain('can_manage_family');
  });

  it('the update policy guards the row it leaves as well as the row it finds', () => {
    // `using` alone stops a non-manager touching something already sensitive.
    // Without `with check` they could still move an ordinary document INTO the
    // vault and hide it from the adults.
    const policy = MIGRATION.slice(MIGRATION.indexOf('create policy documents_update on public.documents'));
    const body = policy.slice(0, policy.indexOf(';'));
    expect(body).toContain('using (');
    expect(body).toContain('with check (');
    expect((body.match(/is_sensitive_document/g) ?? []).length).toBe(2);
  });
});

describe('the bytes are covered too, not just the row', () => {
  it.each(['read', 'update', 'delete'])('the storage %s policy checks the document behind the object', (verb) => {
    const policy = MIGRATION.slice(MIGRATION.indexOf(`create policy "Family members can ${verb} their documents"`));
    const body = policy.slice(0, policy.indexOf(';\n'));
    expect(body).toContain('d.storage_path = storage.objects.name');
    expect(body).toContain('is_sensitive_document');
  });

  it('lets an object with no row through, so an upload does not race its own policy', () => {
    // The Files hub uploads the file, then inserts the row. A policy that
    // required a matching row would reject every upload.
    expect(MIGRATION).toContain('and not exists (');
    expect(MIGRATION).not.toContain('and exists (\n      select 1 from public.documents d\n      where d.storage_path');
  });
});


describe('the Files hub refuses rather than downgrades', () => {
  const raw = readFileSync('components/modules/files-hub-module.tsx', 'utf8');
  // Comments here describe the shape being replaced, so assert against code.
  const hub = raw.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

  // WHAT the hub refuses, and that a refusal performs neither the storage
  // upload nor the documents insert, is proved by executing the real decision
  // in tests/document-upload-refusal.test.ts. Source-text assertions could not
  // tell "refuses" from "refuses too late" — they only ever compared two
  // indexOf positions, which is a fact about line order, not about behaviour.
  //
  // What is left here is the one thing a unit test genuinely cannot reach: that
  // the component still routes through that decision rather than growing a
  // second copy of the rule inline.
  it('routes the upload through the one shared decision', () => {
    expect(hub).toContain("from '@/lib/documents/upload'");
    expect(hub).toContain('await performUpload(');
    // No second copy of either rule in the component.
    expect(hub).not.toMatch(/is_secure:\s*view === 'vault' && manager/);
    expect(hub).not.toMatch(/isSensitiveCategory\(/);
  });

  it('hands performUpload the acting member\'s role, not a hardcoded one', () => {
    // The decision is only worth anything if the component tells it who is
    // uploading. `manager` comes from `isManager(role)` on the app context.
    expect(hub).toContain('const manager = isManager(role);');
    expect(hub).toMatch(/\{ view, category, manager, folderFallback: meta\.folder \}/);
  });

  it('shares one definition of sensitive with the server, not a second list', () => {
    for (const category of ['medical', 'Passport ', 'BANK']) {
      expect(isSensitiveCategory(category)).toBe(true);
    }
    expect(isSensitiveCategory('school')).toBe(false);
    expect(isSensitiveCategory(null)).toBe(false);
  });
});
