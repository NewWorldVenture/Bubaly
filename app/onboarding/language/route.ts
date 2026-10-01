// app/onboarding/language/route.ts — where onboarding makes a signed-out
// language choice the entering account's own (#705 review 5374948393;
// lib/i18n/sync.ts claimSignedOutChoice). A Route Handler, because the claim
// writes a cookie: a page render cannot, and finalize must not (a cookie
// written there re-renders /onboarding past the "all set" step).
import { NextResponse } from 'next/server';

import { claimSignedOutChoice } from '@/lib/i18n/sync';

export async function GET(request: Request) {
  await claimSignedOutChoice();
  // Back to the wizard with the query it was entered with (review plan,
  // calendar status). Whatever the claim answered, the marker is no longer
  // unowned for a signed-in account, so the page renders the wizard this time.
  const url = new URL(request.url);
  const response = NextResponse.redirect(new URL(`/onboarding${url.search}`, url.origin), 303);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
