// Reading EVERY auth user, when "every" is the contract.
//
// `supabase.auth.admin.listUsers()` with no arguments sends an empty per_page,
// so GoTrue applies its own default of 50 and answers with the first page. No
// error, no short-read signal: the caller receives 50 users and believes that
// is the project.
//
// For a page that renders a list that is a display bug. For the notification
// mailer it was silent, permanent loss: a recipient beyond the 50th resolved to
// no metadata, `!meta?.email` matched the "no email on file" branch, and their
// notifications were stamped `sent_at` — marked delivered, never sent, never
// retried. The truncation was indistinguishable from a user who genuinely has
// no address.
//
// This pages explicitly and stops when a page comes back EMPTY, exactly as
// lib/supabase/read-all.ts does. Stopping on a page merely SHORTER than the one
// requested would rebuild the bug: GoTrue is free to clamp per_page below what
// the client asks for, and then the very first page is "short" and the read
// ends at the server's cap — which is the whole defect. An empty page is the
// only signal that cannot be confused with a cap.
//
// It also deliberately does not use the `nextPage` the client returns: that
// value is parsed out of the Link header with `.substring(0, 1)` — one
// character — so page 10 reads as page 1 and paging would loop. Measured
// against @supabase/auth-js 2.108.2.
//
// Errors are returned, never swallowed. A caller that cannot get the whole list
// must be able to tell, because the whole point is that an incomplete list is
// not safely distinguishable from a complete one further down.

/** Users requested per round trip. The server may answer with fewer. */
const PAGE_SIZE = 1000;
/** A stop so a paging bug cannot become an infinite loop. */
const MAX_PAGES = 10_000;

type AuthUserLike = { id: string };
type ListUsersResponse<U> = { data: { users?: U[] | null } | null; error: unknown };
type Admin<U> = {
  auth: { admin: { listUsers: (params?: { page?: number; perPage?: number }) => Promise<ListUsersResponse<U>> } };
};

/**
 * Every auth user in the project, or the error that stopped the read.
 *
 * `{ users, error: null }` means the list is COMPLETE. Any error means it is
 * not, and the caller must not treat a missing user as an absent one.
 */
export async function listAllAuthUsers<U extends AuthUserLike>(
  admin: Admin<U>,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: { pageSize?: number; maxPages?: number } = {},
): Promise<{ users: U[]; error: unknown }> {
  const users: U[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) return { users: [], error };
    const batch = data?.users ?? [];
    // An EMPTY page is the end. A short page is not: the server may have clamped
    // per_page, and treating its cap as the end of the list is the defect this
    // helper exists to remove. One extra round trip is the cost of not guessing.
    if (batch.length === 0) return { users, error: null };
    users.push(...batch);
  }
  return {
    users: [],
    error: new Error(
      `listAllAuthUsers stopped after ${maxPages} pages of ${pageSize}; refusing to report a partial list as complete`,
    ),
  };
}
