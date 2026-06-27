// Pure template engine for programmatic SEO pages. No I/O — fully unit-tested.
// A template's text fields contain {variable} placeholders; pages supply the
// variable values. Content is always DERIVED here (never materialized), so
// editing a template re-renders every page.

export type FeatureBlock = { icon?: string; title: string; description: string };
export type FaqItem = { q: string; a: string };

export type SeoTemplate = {
  id: string;
  name: string;
  topic: string | null;
  slug_pattern: string;
  eyebrow: string | null;
  h1_template: string;
  subhead_template: string | null;
  meta_title_template: string | null;
  meta_description_template: string | null;
  intro_template: string | null;
  feature_blocks: FeatureBlock[];
  faqs: FaqItem[];
  cta_label: string | null;
  cta_href: string;
  static_vars: Record<string, string>;
  is_active: boolean;
};

export type Vars = Record<string, string>;

/** Lowercase, hyphenate, strip anything that isn't a-z 0-9 or '-'. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['’.,]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Replace every {key} in `str` with vars[key]. Unknown placeholders collapse to
 * an empty string (then any doubled spaces are tidied) so a half-filled template
 * never ships literal "{foo}" text to a public page. Also supports a `:upper`,
 * `:lower`, and `:slug` filter, e.g. {state:upper}.
 */
export function interpolate(str: string | null | undefined, vars: Vars): string {
  if (!str) return '';
  const out = str.replace(/\{([a-z0-9_]+)(?::(upper|lower|slug))?\}/gi, (_m, key: string, filter?: string) => {
    const raw = vars[key.toLowerCase()];
    if (raw == null) return '';
    if (filter === 'upper') return raw.toUpperCase();
    if (filter === 'lower') return raw.toLowerCase();
    if (filter === 'slug') return slugify(raw);
    return raw;
  });
  // Tidy whitespace artifacts left by empty placeholders.
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}

/**
 * The static slug prefix of a pattern — every segment before the first that
 * contains a {variable}. e.g. 'family-organizer/{state_slug}' → 'family-organizer'.
 * This is the URL of the template's hub/index page. Returns '' when the very
 * first segment is already a variable (no usable hub).
 */
export function hubSlug(pattern: string): string {
  const out: string[] = [];
  for (const seg of pattern.split('/')) {
    if (seg.includes('{')) break;
    const s = slugify(seg);
    if (s) out.push(s);
  }
  return out.join('/');
}

/** Resolve a slug_pattern against vars → a normalized path without a leading slash. */
export function resolveSlug(pattern: string, vars: Vars): string {
  const interpolated = interpolate(pattern, vars);
  return interpolated
    .split('/')
    .map((seg) => slugify(seg))
    .filter(Boolean)
    .join('/');
}

/** Split an intro body into paragraphs on blank lines, interpolating each. */
export function renderParagraphs(intro: string | null | undefined, vars: Vars): string[] {
  if (!intro) return [];
  return intro
    .split(/\n\s*\n/)
    .map((p) => interpolate(p.replace(/\n/g, ' '), vars))
    .filter((p) => p.length > 0);
}

export type RenderedPage = {
  slug: string;
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  h1: string;
  subhead: string;
  paragraphs: string[];
  features: FeatureBlock[];
  faqs: FaqItem[];
  ctaLabel: string;
  ctaHref: string;
};

/** Merge a template's static vars with page-specific vars (page wins). */
export function mergeVars(template: SeoTemplate, pageVars: Vars): Vars {
  const year = String(new Date().getFullYear());
  return { year, ...template.static_vars, ...pageVars };
}

/** Fully resolve a template + page variables into render-ready content. */
export function renderPage(template: SeoTemplate, pageVars: Vars): RenderedPage {
  const vars = mergeVars(template, pageVars);
  const h1 = interpolate(template.h1_template, vars);
  const metaTitle = interpolate(template.meta_title_template || template.h1_template, vars);
  const metaDescription = interpolate(
    template.meta_description_template || template.subhead_template || template.h1_template,
    vars,
  );
  return {
    slug: resolveSlug(template.slug_pattern, vars),
    metaTitle,
    metaDescription,
    eyebrow: interpolate(template.eyebrow, vars),
    h1,
    subhead: interpolate(template.subhead_template, vars),
    paragraphs: renderParagraphs(template.intro_template, vars),
    features: (template.feature_blocks ?? []).map((f) => ({
      icon: f.icon,
      title: interpolate(f.title, vars),
      description: interpolate(f.description, vars),
    })),
    faqs: (template.faqs ?? []).map((f) => ({
      q: interpolate(f.q, vars),
      a: interpolate(f.a, vars),
    })),
    ctaLabel: interpolate(template.cta_label || 'Get started free', vars),
    ctaHref: template.cta_href || '/signup',
  };
}

/** A short, human label for a page row in the admin list (derived, not stored). */
export function pageLabel(template: SeoTemplate, pageVars: Vars): string {
  return interpolate(template.h1_template, mergeVars(template, pageVars));
}
