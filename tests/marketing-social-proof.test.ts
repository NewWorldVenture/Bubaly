import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Social proof is only what the database can back. The reader returns
// published rows and nothing else; the band renders nothing when there is
// nothing; the "Verified outcome" badge is gated on an admin-set timestamp;
// and no card ever carries an invented name.
const reader = readFileSync('lib/marketing/reputation-server.ts', 'utf8');
const band = readFileSync('components/marketing/social-proof-band.tsx', 'utf8');
const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

describe('lib/marketing/reputation-server.ts', () => {
  it('is server-only and reads with the service client', () => {
    expect(reader.trimStart().startsWith("import 'server-only'")).toBe(true);
    expect(reader).toContain('createServiceClient');
  });

  it('reads only published rows, in sort order, through the pure helpers', () => {
    expect(reader).toContain(".eq('is_published', true)");
    expect(reader).toContain(".order('sort_order')");
    expect(reader).toContain('publishedOnly(');
    expect(reader).toContain('clampRating(');
  });

  it('caps the lists and caches for an hour', () => {
    expect(reader).toContain('TESTIMONIAL_LIMIT = 6');
    expect(reader).toContain('CASE_STUDY_LIMIT = 3');
    expect(reader).toContain('revalidate: 3600');
  });

  it('logs a failed read and returns an empty list rather than a placeholder', () => {
    expect(reader).toContain("console.error('[marketing-reputation] testimonials read failed'");
    expect(reader).toContain("console.error('[marketing-reputation] case studies read failed'");
    expect(reader.match(/return \[\];/g)?.length).toBe(2);
  });

  it('reads verified_at loosely instead of editing the generated types', () => {
    expect(reader).toContain('(row as { verified_at?: string | null }).verified_at');
  });
});

describe('components/marketing/social-proof-band.tsx', () => {
  it('returns null when nothing is published', () => {
    expect(band).toContain('if (!testimonials.length && !caseStudies.length) return null;');
  });

  it('gates the verified badge on verified_at', () => {
    const badgeAt = band.indexOf("t('socialProof.verifiedBadge')");
    expect(badgeAt).toBeGreaterThan(0);
    const guard = band.slice(band.lastIndexOf('{study.verifiedAt &&', badgeAt), badgeAt);
    expect(guard).toContain('study.verifiedAt &&');
  });

  it('carries no literal person names', () => {
    for (const name of [/Jessica M\./, /David T\./, /Amanda R\./, /Sarah/, /Michael/]) {
      expect(band).not.toMatch(name);
    }
  });

  it('labels what it shows honestly', () => {
    for (const key of ['socialProof.sharedWithPermission', 'socialProof.customerWords', 'socialProof.verifiedBadge', 'socialProof.referTitle', 'socialProof.referBody', 'socialProof.ratingLabel']) {
      expect(band).toContain(key);
      expect(en[key], key).toBeTruthy();
    }
    // Cards are not links: there is no /stories route yet.
    expect(band).not.toContain('/stories');
    expect(band).not.toContain('<Link');
  });
});
