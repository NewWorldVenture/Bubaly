// lib/i18n/scopes.ts — how much of the catalogue each surface sends to the browser.
//
// The root layout used to hand LocaleProvider the WHOLE merged catalogue for the
// active locale. LocaleProvider is a client component, so React serialises that
// object into the RSC payload of every page. Measured against production on
// 2026-09-13, /cookies — a legal page whose visible content is a few hundred
// words — was 950 KB of HTML, 266 KB compressed, of which 246 KB was the
// catalogue. Ninety-three per cent of the bytes on a public page were strings
// for surfaces that page cannot reach: wallet errors, marketplace copy, the
// admin studio's capability matrix, onboarding flows.
//
// Sending ONE locale rather than eleven was already right. What remained is that
// a marketing page needs 26 of the 13,449 keys, and an authenticated dashboard
// needs a different 3,791. So each surface now declares the namespaces its own
// CLIENT components use, and ships those.
//
// A scope is a list of NAMESPACES (the segment before the first dot), not of
// individual keys. A namespace is the unit a component actually owns, it keeps
// the declaration readable, and it survives a component adding a sibling string
// — which an exact key list would not.
//
// tests/i18n-client-scope.test.ts walks the import graph from every page in the
// app, collects the keys its reachable client components pass to t(), and fails
// if a scope does not cover them. Adding a key outside your surface's scope is
// therefore a test failure, not a raw key rendered at a visitor.

import type { Messages } from '@/lib/i18n/messages';

/**
 * What the root layout itself renders: the toast host, the Android back
 * handler, and the error boundaries that live directly under it.
 *
 * Every other scope includes this, because everything renders inside it.
 */
//
// `a11y` is here rather than in each surface's own list, and that is a deliberate
// widening. Those keys are the accessible NAMES of controls — Delete, Close,
// Clear search — and a control can appear on any surface: the blog's search
// field, a public gift page, the sign-in screen. Scoping them per surface means
// that adding an `aria-label` to an auth component fails a test about
// authentication copy, for a reason that has nothing to do with the author's
// intent. 28 short strings in the active locale is a few hundred bytes against
// the marketing scope's 2 KB, and the alternative is a guard that punishes the
// right change.
// `logo` and `language` are here rather than repeated per surface because they
// are demonstrably on more than one: the brand mark and the language picker
// render in the marketing chrome, the auth chrome and the public-link chrome.
// Everything narrower stays on the surface that actually mounts it — a scope
// that collects "probably shared" is a scope on its way back to `all`.
export const ROOT_CHROME_SCOPE = ['a11y', 'error', 'globalError', 'root', 'logo', 'language'] as const;

/** The public marketing site, /blog and the hosted form and landing routes. */
export const MARKETING_SCOPE = [
  ...ROOT_CHROME_SCOPE,
  'blogBlogSearch', 'blogTableOfContents', 'fFormRenderer', 'faqTabs',
  'formRenderer', 'handledProof', 'pricingValue', 'subscribe', 'tableOfContents',
  // The shared chrome this surface mounts, which tests/i18n-client-scope.test.ts
  // could not see until its entry globs were fixed: a git pathspec `**\/`
  // requires at least one intervening directory, so `app/(marketing)/**\/layout.tsx`
  // matched NOTHING and the route group's root layout — where the header, the
  // cookie banner and the skip link mount — was never walked. Every one of
  // these keys rendered correct English on the live site anyway, through
  // `translate`'s SOURCE_MESSAGES fallback. That fallback is what PERF-001
  // wants to remove from the client bundle, and removing it while these were
  // out of scope would have put raw keys on the cookie banner's buttons.
  'nav', 'marketing', 'consentManager', 'modal', 'registerSw', 'exitIntent',
  'backToTop', 'skipLink',
  // `consentUi` is reached ONLY through the CONSENT_UI table in
  // lib/marketing/consent-ui.ts, via `t(c.labelKey)` — a non-literal call the
  // scan above cannot resolve. It is listed by hand for that reason, and a new
  // entry in that table under a new namespace would need the same treatment.
  'consentUi',
] as const;

/** Sign-in, sign-up and the consent screens. */
export const AUTH_SCOPE = [
  ...ROOT_CHROME_SCOPE,
  'kidLogin', 'legalConsent', 'login', 'loginForm', 'oauthButtons',
  'phoneAuth', 'signup', 'signupForm',
  // Password recovery, sign-out and step-up reach the auth surface as client
  // components too. Without these namespaces their strings are not shipped, and
  // this scope's whole failure mode — per tests/i18n-client-scope.test.ts — is
  // rendering a raw key like `authRecovery.sendLink` at the person trying to
  // get back into their account. `actions` carries the two kid-login errors
  // that the sign-in form surfaces from the server action.
  'authRecovery', 'authCallback', 'signOutButton', 'stepUp', 'actions',
] as const;

/** The public link surfaces that sit outside a route group: a gift, a review. */
export const PUBLIC_LINK_SCOPE = [
  ...ROOT_CHROME_SCOPE,
  'publicGift', 'publicGiftForm', 'reviewForm', 'reviewsNewReviewForm',
  // The join-invite flow, invisible for the same entry-glob reason: /join's
  // own layout and page were never walked, so nine keys in the surface that
  // brings a new member into a family were outside its scope.
  'joinInvite',
] as const;

/**
 * The keys under the given namespaces.
 *
 * Note what is NOT offered: a scope for the authenticated app. Its client
 * components reach 3,791 keys across 368 namespaces and call t() with a
 * non-literal argument in 96 places, so no static analysis can prove a subset
 * complete — it keeps the whole catalogue, deliberately, and pays the bytes
 * behind a login where there is no crawler and no first-visit cost.
 */
export function scopeMessages(messages: Messages, namespaces: readonly string[]): Messages {
  const wanted = new Set(namespaces);
  const scoped: Messages = {};
  for (const key in messages) {
    const dot = key.indexOf('.');
    if (wanted.has(dot === -1 ? key : key.slice(0, dot))) scoped[key] = messages[key];
  }
  return scoped;
}
