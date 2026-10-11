import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

// The held 0508 makes the household's tax documents, and their files, a
// parent's or adult's (the owner's decision on PROD-002). The Tax Vault page
// must then tell anyone else so, before it asks them for a second factor they
// would never be asked for and before it renders a vault the database returns
// empty. A manager's path through the page is unchanged.

const PAGE = 'app/(app)/dashboard/tax-vault/page.tsx';
const MIGRATION = 'supabase/reserved/0508_tax_documents_are_a_managers.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];

const read = (p: string) => readFileSync(p, 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('tax documents are a manager\'s', () => {
  it('the Tax Vault answers a non-manager before the step-up and the module', () => {
    const src = read(PAGE);
    expect(src).toContain("import { isManager } from '@/lib/constants/roles';");
    const gate = between(src, 'if (!isManager(ctx.active.role)) {', "await requireAal2(ctx, 'documents', '/dashboard/tax-vault');");
    expect(gate).toContain("title={t('taxVault.keptByParents')}");
    expect(gate).toContain("description={t('taxVault.keptByParentsBody')}");
    expect(gate).toContain('return <EmptyState');
    // The context guard still runs first, and the manager still meets the step-up before the module.
    expect(at(src, "await requireFeature('/dashboard/tax-vault')")).toBeLessThan(at(src, 'if (!isManager(ctx.active.role))'));
    expect(between(src, "await requireAal2(ctx, 'documents', '/dashboard/tax-vault');", '<TaxVaultModule />')).toBeTruthy();
  });

  it('says so in every language', () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      expect(messages['taxVault.keptByParents'], locale).toBeTruthy();
      expect(messages['taxVault.keptByParentsBody'], locale).toBeTruthy();
    }
  });

  it('the migration gives the rows four manager-only policies and keeps 0391\'s step-up', () => {
    const sql = squash(read(MIGRATION));
    for (const [name, verb] of [
      ['Managers read tax_documents', 'select'], ['Managers add tax_documents', 'insert'],
      ['Managers change tax_documents', 'update'], ['Managers remove tax_documents', 'delete'],
    ]) {
      expect(sql).toContain(`create policy "${name}" on public.tax_documents for ${verb} to authenticated`);
    }
    expect(sql).not.toMatch(/drop policy[^;]*tax_documents_step_up_/);
    expect(sql).toContain('where polrelid = \'public.tax_documents\'::regclass and polpermissive loop');
  });

  it('withholds the files the Tax Vault uploads, under the folder the module writes', () => {
    const sql = squash(read(MIGRATION));
    expect(sql).toContain("create policy \"Tax files are a manager's\" on storage.objects as restrictive for all to authenticated");
    expect(sql).toContain("lower(coalesce(s.second, '')) = 'tax'");
    // The files answer to the same step-up 0391 asks of the rows (#999 review 6101849884).
    expect(sql).toContain('select not (public.can_manage_family(s.fam) and public.session_cleared_step_up())');
    // The module uploads to {family}/tax/<year>/…, the folder the policy names.
    expect(read('components/modules/tax-vault-module.tsx')).toContain('folder: `tax/${form.tax_year}`');
  });
});
