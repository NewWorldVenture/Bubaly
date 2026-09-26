import { expectTranslates } from './helpers/translated';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildAdminDigest, buildHeadline, digestSubject, renderAdminDigestHtml, summarizeDigestDelivery,
} from '@/lib/admin/digest';

const row = (kind: string, title = 't') => ({ kind, title, created_at: '2026-07-15T00:00:00Z' });
const routeSource = readFileSync('app/api/cron/admin-digest/route.ts', 'utf8');

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

describe('summarizeDigestDelivery', () => {
  it('does not count skipped email delivery as sent', () => {
    expect(summarizeDigestDelivery([{ ok: true, skipped: true }]))
      .toEqual({ ok: true, sent: 0, skipped: 1, failed: 0 });
  });

  it('marks partial provider failures as unsuccessful while preserving counts', () => {
    expect(summarizeDigestDelivery([{ ok: true }, { ok: false }, { ok: true, skipped: true }]))
      .toEqual({ ok: false, sent: 1, skipped: 1, failed: 1 });
  });
});

describe('the digest counts the whole day, not the first page of it (C1-S9-12)', () => {
  it('pages the notification feed instead of capping it', () => {
    // `digest.total` is `rows.length` and the order is created_at DESC, so a
    // `.limit(500)` here did not shorten a list — it UNDER-REPORTED the day and
    // dropped its earliest twenty-odd hours, while the email presented the
    // remainder as the total. Only eight rows are ever rendered (`recent` is
    // sliced to 8), so this read exists for the counts alone.
    expect(routeSource).not.toMatch(/from\('admin_notifications'\)[\s\S]{0,240}?\.limit\(/);
    expect(routeSource).toContain('readAll<DigestRow>(');
    expect(routeSource).toContain(".from('admin_notifications')");
    expect(routeSource).toContain('.range(from, to)');
    // A REAL ceiling. `.limit(n)` is not one: PostgREST caps at db-max-rows
    // whatever the client asks for, whereas readAll's `max` is honoured by
    // paging to it and reads one row past to detect truncation.
    expect(routeSource).toMatch(/\{ max: 20_000 \}/);
  });

  it('treats a truncated read as a failed read, not a short digest', () => {
    // readAll returns the prefix AND an error when more rows remain, so the
    // single `feedError` branch covers both a transport failure and a day that
    // overflowed the ceiling. Either way the scheduler sees 502 and retries,
    // rather than a confident undercount landing in a super admin's inbox.
    const read = routeSource.slice(routeSource.indexOf('const { rows: feed, error: feedError }'));
    const bail = read.indexOf('if (feedError)');
    const use = read.indexOf('buildAdminDigest(');
    expect(bail, 'the read must be bailed on').toBeGreaterThan(-1);
    expect(use, 'the digest must be built from it').toBeGreaterThan(-1);
    expect(bail).toBeLessThan(use);
    expect(read.slice(bail, use)).toContain('{ status: 502 }');
  });

  it('total reflects every row it was given', () => {
    // The property the route's read has to preserve, asserted on the pure
    // function so it cannot drift: 1,200 rows is 1,200, not 500.
    const many = Array.from({ length: 1200 }, (_, i) => row(i % 3 === 0 ? 'family_signup' : 'info'));
    const d = buildAdminDigest(many);
    expect(d.total).toBe(1200);
    expect(d.byKind.find((k) => k.kind === 'family_signup')!.count).toBe(400);
  });
});

describe('admin digest route failure boundary', () => {
  it('fails closed when the Supabase notification feed read fails', () => {
    expect(routeSource).toContain('feedError');
    expectTranslates(routeSource, 'adminDigest.notificationFeedUnavailable', "Notification feed unavailable.");
    expect(routeSource).toContain('{ status: 502 }');
  });

  it('uses the delivery summary instead of counting boolean success blindly', () => {
    expect(routeSource).toContain('summarizeDigestDelivery(');
    expect(routeSource).toContain('summary.ok ? 200 : 502');
  });
});
