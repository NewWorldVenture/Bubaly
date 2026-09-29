/**
 * One page of the marketing content pipeline.
 *
 * The admin pipeline read every item in one query, and PostgREST answers at
 * most 1,000 rows: past that the rest of the pipeline was silently missing, and
 * an idea saved without a publish date (which sorts last) never appeared.
 * Audit ADMIN-CONTENT-001.
 */
export const CONTENT_PAGE_SIZE = 50;

export function contentPage(raw: string | undefined, total: number | null) {
  const pages = Math.max(1, Math.ceil((total ?? 0) / CONTENT_PAGE_SIZE));
  const asked = Math.floor(Number(raw ?? '1'));
  const page = Number.isFinite(asked) && asked >= 1 ? asked : 1;
  const from = (page - 1) * CONTENT_PAGE_SIZE;
  return { page, pages, from, to: from + CONTENT_PAGE_SIZE - 1 };
}
