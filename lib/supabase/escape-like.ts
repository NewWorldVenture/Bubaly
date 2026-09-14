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
