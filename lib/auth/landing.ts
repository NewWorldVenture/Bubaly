// lib/auth/landing.ts — where a signed-in member lands (M28, role-aware landing).
//
// A guest — the role an extended-family invite uses — is in the household to
// stay in touch, not to run it, so the simplified Grandparent Portal is their
// landing rather than the full concierge Home. Everyone else keeps /home.
//
// This is a LANDING decision, not a navigation one: the shared sidebar is
// untouched, the portal keeps the nav entry it already had for everybody, and a
// guest can still open /home. Pure and dependency-free so the sign-in action,
// the OAuth callback and the tests all get the same answer from one place
// (importing it must not drag the whole Supabase auth module along).

export const GUEST_LANDING_PATH = '/dashboard/grandparent-portal';
export const DEFAULT_LANDING_PATH = '/home';

export function landingPathForRole(role: string | null | undefined): string {
  return role === 'guest' ? GUEST_LANDING_PATH : DEFAULT_LANDING_PATH;
}
