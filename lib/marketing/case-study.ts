export const CASE_STUDIES_CACHE_TAG = 'public-case-studies';

export function isCaseStudySlug(slug: string): boolean {
  return !!slug.trim() && slug.length <= 200 && slug !== '.' && slug !== '..' && !/[\u0000-\u001f\u007f]/.test(slug);
}

/** A slug is a path segment, even if an imported record contains punctuation. */
export function caseStudyPath(slug: string): string {
  if (!isCaseStudySlug(slug)) throw new Error('Invalid customer story slug');
  return `/customers/${encodeURIComponent(slug)}`;
}
