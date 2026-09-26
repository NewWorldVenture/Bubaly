// The one normalised form a grocery item's name is compared under.
//
// Case, a trailing plural 's' and runs of whitespace are not differences:
// "Milk", "milk  " and "Milks" are one line on a shopping list, and a family
// that types the second while the first is still unbought wants the line it
// already has, not a second one.
//
// It lives here, in a leaf module, rather than in `lib/services/groceries`
// where it was born, for a reason worth keeping in view: that file opens with
// `import 'server-only'`, and the competitor importer's resolver
// (`lib/migrate/resolve.ts`) is deliberately pure and DOM-free so the review
// wizard can be type-checked against it in the browser. Importing the service
// into the resolver would make the resolver server-only by contagion; copying
// the four-operation rule into it would give the repo two duplicate-detection
// rules for one list.
//
// Two copies of a MATCHING rule are worse than two copies of most things: they
// only ever disagree about the items a family loses or gets twice, and they
// disagree silently. The same file records four disagreeing
// get-or-create-the-list implementations as the cost of re-typing a rule per
// surface; this is that lesson applied before the second copy exists.
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
}
