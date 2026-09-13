// lib/marketing/content-revisions.ts — when each hand-written public page last
// meaningfully changed.
//
// `lastmod` in a sitemap is a claim to search engines: "the content at this URL
// changed on this date". app/sitemap.ts used to answer it with `new Date()` for
// every static route, which made the claim false for ~1,500 URLs at once — every
// regeneration told Google that the entire site had just been rewritten. A
// crawler that learns your lastmod is noise starts ignoring it, and you lose the
// signal exactly when a page really does change.
//
// Database-backed pages already have a real answer in their `updated_at`. These
// are the pages whose content lives in the repository, so their revision date
// has to live here too — a constant that changes when the copy changes, and
// stays put when it does not.
//
// MAINTENANCE: editing a page's COPY means editing its date here. Reformatting,
// renaming a variable, fixing a class name, or lifting a string into the message
// catalogue is not a content change and must not move the date — that is the
// same "everything changed today" lie in slower motion.

/** A calendar date in the W3C / ISO-8601 form sitemaps require. */
export type RevisionDate = `${number}-${number}-${number}`;

/**
 * The legal pages' revision dates.
 *
 * Shared with the pages themselves, which render this as "Last updated" — one
 * value, so the date a reader sees and the date a crawler is told can never
 * disagree. These must reflect an actual policy revision, not a deploy.
 */
export const LEGAL_REVISED = {
  '/privacy': '2026-06-24',
  '/terms': '2026-06-24',
  '/cookies': '2026-06-24',
  '/acceptable-use': '2026-06-24',
} as const satisfies Record<string, RevisionDate>;

/**
 * Every other hand-written public page.
 *
 * Seeded from each page file's last commit date, so the first value set here is
 * an observation rather than a guess.
 */
export const PAGE_REVISED = {
  '': '2026-09-07',
  '/features': '2026-09-08',
  '/how-it-works': '2026-09-07',
  '/pricing': '2026-09-08',
  '/ai': '2026-09-09',
  '/mobile': '2026-09-08',
  '/family-display': '2026-09-09',
  '/security': '2026-09-09',
  '/faq': '2026-09-09',
  '/blog': '2026-09-07',
  '/contact': '2026-09-07',
} as const satisfies Record<string, RevisionDate>;

/** Every hand-written public page, legal included. */
export const STATIC_REVISED: Record<string, RevisionDate> = {
  ...PAGE_REVISED,
  ...LEGAL_REVISED,
};

/**
 * The revision date for a repository-authored path, as a Date.
 *
 * Returns undefined rather than today's date for a path with no entry: an
 * omitted `lastmod` tells a crawler nothing, which is honest, while a
 * fabricated one tells it something false. A test asserts every routed path
 * has an entry, so undefined means someone added a route and forgot — a gap to
 * fix, not to paper over at runtime.
 */
export function staticRevision(path: string): Date | undefined {
  const iso = STATIC_REVISED[path];
  return iso ? new Date(`${iso}T00:00:00.000Z`) : undefined;
}
