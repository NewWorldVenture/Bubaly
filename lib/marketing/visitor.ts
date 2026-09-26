// lib/marketing/visitor.ts — client-only visitor plumbing for the consent
// manager: a durable anonymous id, GPC detection, a local consent cache (so the
// banner doesn't re-nag), and the POST helpers to /api/mkt/consent + /api/mkt/track.
// Browser-only (guards for SSR); no server imports.
'use client';

import {
  CONSENT_POLICY_VERSION, resolveConsent, type ConsentState,
} from './consent';
import { normalizeState, parseUtmParams } from './consent-ui';

const VID_KEY = 'bubaly_vid';
const CONSENT_KEY = `bubaly_consent_${CONSENT_POLICY_VERSION}`;
const TRACKED_KEY = 'bubaly_tracked'; // sessionStorage — one touch per tab session
const VID_MAX_AGE = 400 * 24 * 60 * 60; // 400 days (Chrome cookie cap)
let touchInFlight = false;
let conversionInFlight = false;

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function writeCookie(name: string, value: string, maxAgeSec: number) {
  if (typeof document === 'undefined') return;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSec}; Path=/; SameSite=Lax${secure}`;
}

/** Stable anonymous visitor id — cookie-first (survives storage clears), mirrored to localStorage. */
export function getAnonymousId(): string {
  if (typeof window === 'undefined') return '';
  let id = readCookie(VID_KEY);
  if (!id) { try { id = localStorage.getItem(VID_KEY); } catch { /* blocked */ } }
  if (!id) id = uuid();
  writeCookie(VID_KEY, id, VID_MAX_AGE);
  try { localStorage.setItem(VID_KEY, id); } catch { /* blocked */ }
  return id;
}

/** Observe attribution without creating or replacing a browser identity. */
export function captureAnonymousId(): string | null {
  try { return readCookie(VID_KEY); } catch { return null; }
}

/** A verified account switch may fork only the attribution it started with. */
export function resetAnonymousId(expected: string | null): boolean {
  if (!expected || captureAnonymousId() !== expected) return false;
  const id = uuid();
  writeCookie(VID_KEY, id, VID_MAX_AGE);
  if (captureAnonymousId() !== id) return false;
  try { localStorage.setItem(VID_KEY, id); } catch { /* Mirroring is optional. */ }
  return true;
}

/** Browser Global Privacy Control / Do-Not-Sell signal. */
export function detectGPC(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

type LocalConsent = { state: ConsentState; decided: boolean; at: number };

export function readLocalConsent(): LocalConsent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalConsent;
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return null;
    return { state: normalizeState(parsed.state), decided: !!parsed.decided, at: parsed.at ?? 0 };
  } catch { return null; }
}

export function writeLocalConsent(state: ConsentState, decided: boolean) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ state, decided, at: Date.now() })); } catch { /* blocked */ }
}

/** The effective state before any explicit choice (honors GPC). */
export function initialConsent(gpc: boolean): ConsentState {
  return resolveConsent([], { gpc });
}

/**
 * Persist a decision durably (append-only, server-side) and return the resolved
 * state. The decision is recorded against the visitor this browser IS — the
 * `bubaly_vid` cookie the same-origin fetch carries — so no id is sent in the
 * body: the route binds to the cookie and refuses a body that names anyone else.
 */
export async function postConsent(
  state: ConsentState, gpc: boolean, source: string,
): Promise<ConsentState | null> {
  try {
    // Make sure the cookie exists (it is written here if storage lost it) so the
    // request below carries the identity the decision belongs to.
    if (!getAnonymousId()) return null;
    const res = await fetch('/api/mkt/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ consents: state, gpc, source }),
      keepalive: true,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; state?: ConsentState };
    return json.state ?? null;
  } catch { return null; }
}

/**
 * Fire a single first-party page-view touch per tab session — but ONLY when the
 * resolved state permits analytics (the server double-checks and no-ops
 * otherwise). Passes the GPC flag so the server honors it too.
 *
 * Like postConsent, no id is sent: the touch is recorded against the visitor
 * this browser IS when it fires — the `bubaly_vid` cookie the same-origin fetch
 * carries — so it is gated on the same consent ledger the banner just wrote to,
 * not on an id a page captured at mount and may have outlived (SEC-007).
 */
export async function trackTouchOnce(state: ConsentState, gpc: boolean): Promise<void> {
  if (typeof window === 'undefined' || !state.analytics) return;
  if (touchInFlight) return;
  try {
    if (sessionStorage.getItem(TRACKED_KEY)) return;
  } catch { /* if sessionStorage is blocked, still fire once */ }
  // Make sure the cookie exists so the request below carries an identity.
  if (!getAnonymousId()) return;

  touchInFlight = true;
  const { source, medium, campaign } = parseUtmParams(location.search);
  const deviceType = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  try {
    const response = await fetch('/api/mkt/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'touch', gpc,
        source, medium, campaign,
        landingPath: location.pathname.slice(0, 200),
        deviceType,
      }),
      keepalive: true,
    });
    if (response.ok) {
      try { sessionStorage.setItem(TRACKED_KEY, '1'); } catch { /* storage is optional */ }
    }
  } catch { /* best-effort */ }
  finally { touchInFlight = false; }
}

/** Record a consent-gated conversion for the current public marketing journey. */
export async function trackConversion(): Promise<void> {
  if (typeof window === 'undefined' || conversionInFlight) return;
  const gpc = detectGPC();
  const state = readLocalConsent()?.state ?? initialConsent(gpc);
  if (!state.analytics) return;

  // The cookie is the identity (see trackTouchOnce); make sure it exists.
  if (!getAnonymousId()) return;

  conversionInFlight = true;
  const { source, medium, campaign } = parseUtmParams(location.search);
  try {
    await fetch('/api/mkt/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'conversion', gpc,
        source, medium, campaign,
        landingPath: location.pathname.slice(0, 200),
        deviceType: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      }),
      keepalive: true,
    });
  } catch { /* conversion telemetry never blocks the user journey */ }
  finally { conversionInFlight = false; }
}
