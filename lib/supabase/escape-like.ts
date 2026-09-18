// lib/supabase/escape-like.ts — one definition, because four were the problem.
//
// `%` and `_` are LIKE/ILIKE wildcards. A value interpolated into a pattern
// without escaping is therefore matched as a PATTERN, not as text, and the
// consequences scale with what the query drives:
//
//   - a search box gets fuzzier than the user asked for ('50%' matches '50' +
//     anything) — wrong, but only cosmetically;
//   - a lookup that then WRITES mutates the first pattern match, so an AI
//     assistant asked to complete "50% off groceries" can complete a different
//     reminder entirely;
//   - a lookup keyed on attacker-supplied text crosses a tenant boundary. That
//     is what `smit_@bubaly.com` reaching the family who owns `smith` was, and
//     what the child sign-in bug was before it.
//
// This repository fixed that class twice and both fixes were local copies, so
// neither reached the next call site. Four identical private `escapeLike`
// functions existed (trips, inventory, home, contact-center) plus two inline
// `.replace(/[%_]/g, …)` expressions. `tests/ilike-patterns-are-escaped.test.ts`
// now requires this one.
//
// Escaping does not break values that legitimately contain these characters:
// verified in PostgreSQL 16, `'smit_h' ilike 'smit\_h'` is true.
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (m) => `\\${m}`);
}

// A pattern inside `.or(...)` needs MORE than escapeLike, and that is the part
// this repository had written down nowhere.
//
// `.ilike(column, pattern)` sends the pattern as its own query parameter, so
// escaping the two LIKE wildcards is the whole job. `.or(filter)` does not: it
// sends one string in PostgREST's filter grammar, where `,` separates the
// disjuncts and `()` groups them. A value carrying either is not escaped by
// escapeLike — it is not a LIKE character — so it leaves the pattern and
// becomes GRAMMAR:
//
//   term = 'a,b'        → or=(feature.ilike.%a,b%,…)   → `b%` is not col.op.val
//                                                        → PostgREST 400
//   term = 'x,status.neq.zzz'
//                       → a fourth disjunct that matches every row, so the
//                         search stops filtering and lists whatever scope it
//                         was already inside
//
// It cannot cross a family boundary — the or-group is AND-ed with the caller's
// `.eq('family_id', …)` and RLS sits under both — so this is a broken search and
// a filter bypass WITHIN scope, not a leak between households. Stated plainly
// because the opposite claim would be the more alarming one and it is not true.
//
// So: follow the repo's own documented rule ("use escapeLike at the call site")
// inside a `.or()` and you still get an injectable filter. That is the gap.
//
// The three grammar characters become a space rather than being escaped,
// because an unquoted PostgREST value has no escape for them. Quoting the value
// (`col.ilike."a,b"`) would preserve the term exactly and was rejected: the
// in-memory Supabase the test suite runs on splits an or-expression on every
// top-level comma without modelling quotes, so a quoted value would work in
// production and break every test that exercises it — shipping behaviour the
// repository cannot test. Widening a search by a space is a smaller cost.
export function escapeOrValue(value: string): string {
  return escapeLike(value.replace(/[(),]/g, ' ')).trim();
}
