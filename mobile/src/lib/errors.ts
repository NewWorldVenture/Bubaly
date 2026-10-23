// What the phone may show when something fails — and what it may not.
//
// A PostgrestError, an AuthError, React Native's fetch TypeError ("Network
// request failed") and a JSON SyntaxError all extend Error, so a catch block
// that renders `error.message` puts "permission denied for table
// chore_assignments", "JWT expired" or 'new row violates row-level security
// policy for table "grocery_items"' on a child's screen. Those messages are
// written for whoever runs the database or the network. The web routes the same
// errors through describeDbError (lib/supabase/errors.ts); the phone's rule is
// simpler: only a MobileError's message was written for the person holding the
// phone, and anything else is logged where it was caught and replaced by the
// caller's fixed copy. Pure — unit-tested from the repo root.

export class MobileError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'MobileError';
  }
}

/** The message to show for a thrown value: the app's own words, or `fallback`. */
export function messageFor(error: unknown, fallback: string): string {
  return error instanceof MobileError ? error.message : fallback;
}
