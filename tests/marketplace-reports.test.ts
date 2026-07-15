import { describe, it, expect } from 'vitest';
import {
  REPORT_REASONS, reasonLabel, STATUS_LABELS, isValidReason, isResolved,
  canReport, summarizeReports, reportMatchesFilter, isReportFilter,
} from '@/lib/marketplace/reports';

describe('reason vocabulary', () => {
  it('every reason has a label + hint', () => {
    expect(REPORT_REASONS.length).toBe(7);
    expect(REPORT_REASONS.every((r) => r.label && r.hint)).toBe(true);
  });
  it('labels and validates reasons', () => {
    expect(reasonLabel('scam')).toBe('Scam or fraud');
    expect(reasonLabel('bogus')).toBe('Reported');
    expect(isValidReason('prohibited')).toBe(true);
    expect(isValidReason('nope')).toBe(false);
  });
  it('has a label for every status', () => {
    expect(STATUS_LABELS.open).toBe('Open');
    expect(STATUS_LABELS.actioned).toBe('Actioned');
  });
});

describe('isResolved', () => {
  it('only terminal statuses are resolved', () => {
    expect(isResolved('open')).toBe(false);
    expect(isResolved('reviewing')).toBe(false);
    expect(isResolved('actioned')).toBe(true);
    expect(isResolved('dismissed')).toBe(true);
  });
});

describe('canReport', () => {
  it('blocks reporting your own listing', () => {
    expect(canReport('m1', 'm1')).toBe(false);
    expect(canReport('m1', 'm2')).toBe(true);
    expect(canReport(null, 'm2')).toBe(true);
    expect(canReport('m1', '')).toBe(false);
  });
});

describe('summarizeReports', () => {
  it('counts total, open (open+reviewing), and by-dimension', () => {
    const rows = [
      { status: 'open', reason: 'scam' },
      { status: 'reviewing', reason: 'scam' },
      { status: 'actioned', reason: 'spam' },
      { status: 'dismissed', reason: 'other' },
    ];
    const s = summarizeReports(rows);
    expect(s.total).toBe(4);
    expect(s.open).toBe(2);
    expect(s.byStatus).toEqual({ open: 1, reviewing: 1, actioned: 1, dismissed: 1 });
    expect(s.byReason.scam).toBe(2);
  });
  it('handles empty input', () => {
    expect(summarizeReports([])).toEqual({ total: 0, open: 0, byStatus: {}, byReason: {} });
  });
});

describe('moderation queue filter', () => {
  it('validates the filter vocabulary', () => {
    expect(isReportFilter('needs_action')).toBe(true);
    expect(isReportFilter('all')).toBe(true);
    expect(isReportFilter('bogus')).toBe(false);
    expect(isReportFilter(undefined)).toBe(false);
  });
  it('"all" matches every status', () => {
    for (const s of ['open', 'reviewing', 'actioned', 'dismissed']) {
      expect(reportMatchesFilter(s, 'all')).toBe(true);
    }
  });
  it('"needs_action" groups open + reviewing only', () => {
    expect(reportMatchesFilter('open', 'needs_action')).toBe(true);
    expect(reportMatchesFilter('reviewing', 'needs_action')).toBe(true);
    expect(reportMatchesFilter('actioned', 'needs_action')).toBe(false);
    expect(reportMatchesFilter('dismissed', 'needs_action')).toBe(false);
  });
  it('terminal filters match only their own status', () => {
    expect(reportMatchesFilter('actioned', 'actioned')).toBe(true);
    expect(reportMatchesFilter('open', 'actioned')).toBe(false);
    expect(reportMatchesFilter('dismissed', 'dismissed')).toBe(true);
    expect(reportMatchesFilter('reviewing', 'dismissed')).toBe(false);
  });
});
