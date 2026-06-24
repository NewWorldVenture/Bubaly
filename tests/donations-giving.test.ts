import { describe, expect, it } from 'vitest';
import {
  donationTypeMeta,
  totalGiving,
  totalTaxDeductible,
  givingByYear,
  givingByOrg,
  givingByType,
  donationSummary,
  fmtMoney,
  fmtDate,
  type DonationLike,
} from '@/lib/donations/giving';

function don(overrides: Partial<DonationLike> & { id: string }): DonationLike {
  return {
    organization: 'Red Cross',
    donation_type: 'monetary',
    amount: 100,
    donation_date: '2026-06-01',
    tax_year: 2026,
    is_tax_deductible: true,
    ...overrides,
  };
}

describe('donationTypeMeta', () => {
  it('returns correct meta', () => {
    expect(donationTypeMeta('monetary').emoji).toBe('💵');
  });
  it('falls back to other', () => {
    expect(donationTypeMeta('other').label).toBe('Other');
  });
});

describe('totalGiving', () => {
  it('sums amounts', () => {
    expect(totalGiving([don({ id: 'a', amount: 100 }), don({ id: 'b', amount: 250 })])).toBe(350);
  });
  it('handles nulls', () => {
    expect(totalGiving([don({ id: 'a', amount: null })])).toBe(0);
  });
});

describe('totalTaxDeductible', () => {
  it('sums only deductible', () => {
    const list = [
      don({ id: 'a', amount: 100, is_tax_deductible: true }),
      don({ id: 'b', amount: 200, is_tax_deductible: false }),
    ];
    expect(totalTaxDeductible(list)).toBe(100);
  });
});

describe('givingByYear', () => {
  it('groups by year, newest first', () => {
    const list = [
      don({ id: 'a', tax_year: 2025, amount: 50 }),
      don({ id: 'b', tax_year: 2026, amount: 100 }),
      don({ id: 'c', tax_year: 2025, amount: 75 }),
    ];
    const result = givingByYear(list);
    expect(result[0]).toEqual({ year: 2026, total: 100, deductible: 100 });
    expect(result[1]).toEqual({ year: 2025, total: 125, deductible: 125 });
  });
});

describe('givingByOrg', () => {
  it('groups and sorts by total', () => {
    const list = [
      don({ id: 'a', organization: 'Habitat', amount: 500 }),
      don({ id: 'b', organization: 'Red Cross', amount: 100 }),
      don({ id: 'c', organization: 'Habitat', amount: 200 }),
    ];
    const result = givingByOrg(list);
    expect(result[0]).toEqual({ org: 'Habitat', total: 700, count: 2 });
    expect(result[1]).toEqual({ org: 'Red Cross', total: 100, count: 1 });
  });
});

describe('givingByType', () => {
  it('groups by type', () => {
    const list = [
      don({ id: 'a', donation_type: 'monetary', amount: 100 }),
      don({ id: 'b', donation_type: 'goods', amount: 50 }),
    ];
    const result = givingByType(list);
    expect(result[0]).toEqual({ type: 'monetary', total: 100 });
    expect(result[1]).toEqual({ type: 'goods', total: 50 });
  });
});

describe('donationSummary', () => {
  it('handles empty', () => {
    const s = donationSummary([], 2026);
    expect(s.text).toBe('No donations recorded yet');
  });
  it('reports current year and top org', () => {
    const list = [don({ id: 'a', amount: 500, organization: 'Habitat' })];
    const s = donationSummary(list, 2026);
    expect(s.currentYearTotal).toBe(500);
    expect(s.topOrg).toBe('Habitat');
    expect(s.text).toContain('$500 this year');
  });
});

describe('fmtMoney', () => {
  it('formats USD', () => {
    expect(fmtMoney(1500)).toBe('$1,500');
  });
  it('returns dash for null', () => {
    expect(fmtMoney(null)).toBe('—');
  });
});

describe('fmtDate', () => {
  it('formats a date', () => {
    expect(fmtDate('2026-06-24')).toBe('Jun 24, 2026');
  });
});
