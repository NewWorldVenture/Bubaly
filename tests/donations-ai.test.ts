import { describe, expect, it } from 'vitest';
import { analyzeDonations, buildDonationsPrompt, parseDonationsResponse, type DonationForAI } from '@/lib/donations/donations-ai';

function donation(overrides: Partial<DonationForAI> = {}): DonationForAI {
  return { organization: 'Red Cross', donation_type: 'monetary', amount: 100, category: 'disaster_relief', donation_date: '2025-05-01', is_tax_deductible: true, ...overrides };
}

describe('analyzeDonations', () => {
  it('summarizes donations', () => {
    const r = analyzeDonations([donation(), donation({ amount: 200, is_tax_deductible: false })]);
    expect(r.totalDonations).toBe(2);
    expect(r.totalAmount).toBe(300);
    expect(r.taxDeductibleCount).toBe(1);
  });

  it('handles empty', () => {
    const r = analyzeDonations([]);
    expect(r.totalDonations).toBe(0);
    expect(r.summary).toContain('No donations');
  });
});

describe('buildDonationsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildDonationsPrompt([donation()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Red Cross');
  });
});

describe('parseDonationsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseDonationsResponse('{"suggestions":["track receipts"],"taxTips":["file early"],"givingStrategy":"monthly giving"}');
    expect(r.suggestions).toEqual(['track receipts']);
    expect(r.givingStrategy).toBe('monthly giving');
  });

  it('handles malformed', () => {
    expect(parseDonationsResponse('bad').suggestions).toEqual([]);
  });
});
