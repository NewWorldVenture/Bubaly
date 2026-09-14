// Reading EVERY auth user, when "every" actually matters.
//
// `supabase.auth.admin.listUsers()` with no arguments does not return the user
// table. It returns the FIRST PAGE — fifty users — and, exactly like the
// unbounded PostgREST select that `read-all.ts` exists for, it says nothing
// about it: no error, no short-read signal the caller sees. The difference is
// that this one is worse by a factor of twenty, because PostgREST's default
// ceiling is a thousand rows and GoTrue's is fifty.
//
// Three callers built an email lookup that way — the weekly digest, the chore
// reminders, and `lib/server/notification-emails.ts`, whose comment says it
// "Mirrors the weekly-digest cron's approach". Every family whose admin was not
// among the first fifty auth users simply had no email on file, and the digest's
// `if (!adminEmail) continue;` skipped them without counting a failure. The cron
// then answered 200 with `failed: 0`.
//
// Paging stops on an EMPTY page, the same rule `readAll` uses, and deliberately
// NOT on `nextPage`: supabase-js parses the page number out of the Link header
// with `.substring(0, 1)` (auth-js `GoTrueAdminApi.listUsers`), so page 10
// arrives as page 1. Nor does it stop on a short page — GoTrue may cap
// `perPage` below what was asked, and a page shorter than requested would then
// look like the end of a table on its first request.

/** Users requested per round trip. The server may answer with fewer. */
const PAGE_SIZE = 1000;
/** A stop so a paging bug cannot become an infinite loop. */
const MAX_PAGES = 500;

type AuthUserLike = { id: string; email?: string | null; user_metadata?: Record<string, unknown> };

type ListUsers<U, E> = (params: { page: number; perPage: number })
  => Promise<{ data: { users: U[] } | null; error: E | null }>;

/**
 * Every auth user, a page at a time.
 *
 * Returns `{ users, error }`. On the first failing page it returns the error
 * and the users read so far — a caller that treats a partial read as complete
 * is the defect this exists to stop, so check `error` before using `users`.
 */
export async function readAllAuthUsers<U extends AuthUserLike, E = unknown>(
  listUsers: ListUsers<U, E>,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: { pageSize?: number; maxPages?: number } = {},
): Promise<{ users: U[]; error: E | null }> {
  // Keyed by id: offset paging over a table someone may be signing up to can
  // hand back the same user twice.
  const byId = new Map<string, U>();

  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await listUsers({ page, perPage: pageSize });
    if (error) return { users: [...byId.values()], error };
    const users = data?.users ?? [];
    if (users.length === 0) return { users: [...byId.values()], error: null };
    for (const user of users) byId.set(user.id, user);
  }

  // Hitting the cap means half a million users or a paging bug. Either way the
  // read is NOT complete, and saying so beats returning a plausible prefix.
  return {
    users: [...byId.values()],
    error: new Error(`readAllAuthUsers stopped at ${maxPages} pages — the read is incomplete`) as E,
  };
}
