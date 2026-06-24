import { describe, expect, it } from 'vitest';
import { analyzeTaxVault, buildTaxVaultPrompt, parseTaxVaultResponse, type TaxDocForAI } from '@/lib/tax-vault/tax-vault-ai';

function doc(overrides: Partial<TaxDocForAI> = {}): TaxDocForAI {
  return { category: 'W-2', tax_year: 2024, name: 'Employer W-2', ...overrides };
}

describe('analyzeTaxVault', () => {
  it('summarizes documents', () => {
    const r = analyzeTaxVault([doc(), doc({ tax_year: 2023 })]);
    expect(r.totalDocuments).toBe(2);
    expect(Object.keys(r.yearCounts)).toHaveLength(2);
  });
  it('handles empty', () => { expect(analyzeTaxVault([]).summary).toContain('No tax'); });
});

describe('buildTaxVaultPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildTaxVaultPrompt([doc()]);
    expect(system).toContain('JSON');
    expect(user).toContain('W-2');
  });
});

describe('parseTaxVaultResponse', () => {
  it('parses valid JSON', () => {
    const r = parseTaxVaultResponse('{"suggestions":["digitize receipts"],"organizationTips":["use folders by year"],"complianceTip":"keep records 7 years"}');
    expect(r.suggestions).toEqual(['digitize receipts']);
  });
  it('handles malformed', () => { expect(parseTaxVaultResponse('bad').suggestions).toEqual([]); });
});
