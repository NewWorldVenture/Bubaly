import { describe, it, expect } from 'vitest';
import {
  buildAdminDigest, buildHeadline, digestSubject, renderAdminDigestHtml,
} from '@/lib/admin/digest';

const row = (kind: string, title = 't') => ({ kind, title, created_at: '2026-07-15T00:00:00Z' });

describe('buildAdminDigest', () => {
  it('is empty for no rows', () => {
    const d = buildAdminDigest([]);
    expect(d.isEmpty).toBe(true);
    expect(d.total).toBe(0);
    expect(d.byKind).toEqual([]);
    expect(d.headline).toMatch(/quiet day/i);
  });

  it('counts and growth-orders kinds (paid + signups lead)', () => {
    const d = buildAdminDigest([
      row('feedback_new'), row('info'), row('subscription'),
      row('family_signup'), row('family_signup'),
    ]);
    expect(d.total).toBe(5);
    expect(d.byKind.map((k) => k.kind)).toEqual(['subscription', 'family_signup', 'feedback_new', 'info']);
    expect(d.byKind[1]).toEqual({ kind: 'family_signup', label: 'New signup', count: 2 });
  });

  it('appends unknown kinds after known ones, alphabetically', () => {
    const d = buildAdminDigest([row('zebra'), row('info'), row('apple')]);
    const order = d.byKind.map((k) => k.kind);
    expect(order[0]).toBe('info');
    expect(order.slice(1)).toEqual(['apple', 'zebra']);
  });
});

describe('buildHeadline', () => {
  it('leads with paid conversions then signups', () => {
    expect(buildHeadline({ subscription: 2, family_signup: 1 }))
      .toBe('2 new paid plans and 1 new family.');
  });
  it('uses singular/plural correctly', () => {
    expect(buildHeadline({ subscription: 1 })).toBe('1 new paid plan.');
    expect(buildHeadline({ family_signup: 3 })).toBe('3 new families.');
  });
  it('serial-joins three or more phrases', () => {
    expect(buildHeadline({ subscription: 1, family_signup: 1, feedback_new: 2 }))
      .toBe('1 new paid plan, 1 new family, and 2 feedback items.');
  });
  it('falls back to a neutral line when only non-growth kinds present', () => {
    expect(buildHeadline({ info: 2 })).toBe('2 updates to review.');
    expect(buildHeadline({})).toMatch(/quiet day/i);
  });
});

describe('digestSubject + renderAdminDigestHtml', () => {
  it('builds a subject with the date + headline', () => {
    const d = buildAdminDigest([row('subscription')]);
    expect(digestSubject(d, 'Jul 15')).toBe('[Bubaly] Daily digest · Jul 15 — 1 new paid plan.');
  });
  it('renders self-contained HTML with the deep link and escapes titles', () => {
    const d = buildAdminDigest([row('feedback_new', 'A <b>bug</b> & more')]);
    const html = renderAdminDigestHtml(d, {
      appUrl: 'https://www.bubaly.com/', dateLabel: 'Jul 15',
      recent: [row('feedback_new', 'A <b>bug</b> & more')],
    });
    expect(html).toContain('https://www.bubaly.com/admin/notifications');
    expect(html).toContain('&lt;b&gt;bug&lt;/b&gt; &amp; more');
    expect(html).not.toContain('<b>bug</b>');
  });
});
