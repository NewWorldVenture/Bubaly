// lib/marketing/visitor-cookie.ts — the server side of the `bubaly_vid` visitor
// id: WHICH anonymous visitor a public marketing request is about.
//
// The answer is the visitor this browser already is — the `bubaly_vid` cookie
// the request carries — never an id the caller chooses to put in a query string
// or a body. A public service-role route that reads or writes a visitor's
// records by that id binds through these two helpers (/api/mkt/consent was
// first, SEC-006; /api/mkt/track followed, SEC-007), so the rule is written once
// for every route that imports them — search for this module's name to see which
// do. "Written once" is not "holds everywhere": a route that does not import
// these helpers is not covered by them, and takes whatever id it takes.
//
// The cookie NAME is also spelled out in lib/marketing/visitor.ts (the client
// that writes the cookie, which cannot import this server-only module) and read
// straight from the cookie jar in app/(auth)/actions.ts and
// lib/auth/recovery-cookies.ts. Those readers are already cookie-bound; they
// just do not share the constant.
//
// What this does NOT add, stated plainly: the id is a random bearer value, and
// the cookie is the same bytes, written from JavaScript. Anyone who already holds
// a visitor's id can present it as a cookie. What the binding removes is a caller
// CHOOSING a record other than the one its own browser carries, the id
// travelling in a URL or a cross-site body, and drift between a stale id held in
// page state and the cookie the browser holds now. Real proof of ownership would
// need a server-issued, signed, HttpOnly visitor id across the marketing layer.
import 'server-only';
import type { NextRequest } from 'next/server';

export const VISITOR_COOKIE = 'bubaly_vid';
export const MAX_VISITOR_ID = 200;

/** The visitor id this request's browser carries, or '' when it carries none. */
export function carriedVisitorId(req: Pick<NextRequest, 'cookies'>): string {
  return req.cookies.get(VISITOR_COOKIE)?.value?.trim().slice(0, MAX_VISITOR_ID) ?? '';
}

/**
 * True when the caller named a visitor id and it is not the one it carries.
 *
 * Older cached clients still send the id they hold; one that IS the cookie is
 * accepted. Naming anyone else is refused by the caller of this, rather than
 * silently re-targeted to the cookie, so a mismatch is visible, not absorbed.
 */
export function namesAnotherVisitor(named: unknown, carried: string): boolean {
  if (named === undefined || named === null) return false;
  return typeof named !== 'string' || named.trim().slice(0, MAX_VISITOR_ID) !== carried;
}
