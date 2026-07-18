import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-17 §3e slice (agent-05, PLA-0793): the public marketing landing page
// (lp/[slug]) and form (f/[id]) loaders dropped the Supabase `error` and returned
// null on failure, so `if (!page) notFound()` turned a TRANSIENT read error into a
// permanent-looking 404 — which de-indexes a real, published page and reads as
// "gone" to visitors. Each loader now throws on a genuine error (retryable 5xx),
// reserving notFound() for a truly missing row.

const lp = fs.readFileSync('app/(marketing)/lp/[slug]/page.tsx', 'utf8');
const form = fs.readFileSync('app/(marketing)/f/[id]/page.tsx', 'utf8');

describe('public marketing loaders throw on read error (never 404 a live page)', () => {
  it('landing-page loader captures error and throws before returning null', () => {
    expect(lp).toContain('const { data, error } =');
    expect(lp).toContain('if (error) throw new Error(');
    // The throw must precede the return (so a real error never yields null → 404).
    expect(lp.indexOf('if (error) throw')).toBeLessThan(lp.indexOf('return data;'));
    // notFound() is still reserved for a genuinely missing page.
    expect(lp).toMatch(/if \(!(?:page|platformPage)\) notFound\(\);/);
  });

  it('public-form loader captures error and throws before returning null', () => {
    expect(form).toContain('const { data, error } =');
    expect(form).toContain('if (error) throw new Error(');
    expect(form.indexOf('if (error) throw')).toBeLessThan(form.indexOf('return data;'));
    expect(form).toContain('if (!form) notFound();');
  });
});
