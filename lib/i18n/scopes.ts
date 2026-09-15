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
export const ROOT_CHROME_SCOPE = [
  'error', 'globalError', 'root',
  // Shared chrome that renders under EVERY surface: the toast host, the brand
  // logo, the language picker and the modal primitive. They were missing from
  // every scope, and nothing noticed because `translate` fell back to the whole
  // English catalogue — the fallback that shipped 244 KB gzip to every visitor.
  'language', 'logo', 'modal', 'toast',
] as const;

/** The public marketing site, /blog and the hosted form and landing routes. */
export const MARKETING_SCOPE = [
  ...ROOT_CHROME_SCOPE,
  'blogBlogSearch', 'blogTableOfContents', 'fFormRenderer', 'faqTabs',
  'formRenderer', 'handledProof', 'pricingValue', 'subscribe', 'tableOfContents',
  // The chrome the marketing LAYOUT renders — the skip link, the header and its
  // navigation, the consent manager, the exit-intent overlay, the back-to-top
  // button, the service-worker notice. Every one of these was missing, because
  // `app/(marketing)/layout.tsx` was never scanned: the entry glob was
  // `app/(marketing)/**​/layout.tsx`, and git's `**` requires at least one path
  // segment, so it matched nothing at all.
  'backToTop', 'consentManager', 'exitIntent', 'marketing', 'nav', 'registerSw',
  'skipLink',
  // …and the page content the same gap hid: the contact form, the AI showcase,
  // the pricing page's own namespaces, the blog's share buttons.
  'aiShowcase', 'blogShareButtons', 'contact', 'contactForm', 'contactTopic',
  'planOutcomes', 'pricingContent', 'pricingPricingContent', 'shareButtons',
  'socialProof', 'switching', 'trustStrip',
] as const;

/** Sign-in, sign-up and the consent screens. */
export const AUTH_SCOPE = [
  ...ROOT_CHROME_SCOPE,
  'kidLogin', 'legalConsent', 'login', 'loginForm', 'oauthButtons',
  'phoneAuth', 'signup', 'signupForm',
  // The phone field's own labels, reached through components/ui/phone-input.tsx.
  'phoneInput',
] as const;

/** The public link surfaces that sit outside a route group: a gift, a review. */
export const PUBLIC_LINK_SCOPE = [
  ...ROOT_CHROME_SCOPE,
  'publicGift', 'publicGiftForm', 'reviewForm', 'reviewsNewReviewForm',
  // /join renders the invite acceptance flow.
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
