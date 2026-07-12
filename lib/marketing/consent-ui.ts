// lib/marketing/consent-ui.ts — pure helpers for the consent banner / preference
// center (unit-tested). No browser or server deps: category presentation, the
// Accept-all / Reject presets, the banner-visibility rule, and UTM parsing all
// live here so the client component stays thin and the logic is testable.
import {
  CONSENT_CATEGORIES, DEFAULT_CONSENT,
  type ConsentCategory, type ConsentState,
} from './consent';

export type ConsentCategoryMeta = {
  key: ConsentCategory;
  label: string;
  description: string;
  /** `necessary` is always on and cannot be toggled off. */
  locked: boolean;
};

// Presentation for each category. Order = display order.
export const CONSENT_UI: ConsentCategoryMeta[] = [
  { key: 'necessary', locked: true,
    label: 'Strictly necessary',
    description: 'Required to run the site — sign-in, security, and remembering your privacy choices. Always on.' },
  { key: 'analytics', locked: false,
    label: 'Analytics',
    description: 'First-party, privacy-respecting usage measurement so we can improve Bubaly. No ad trackers, no fingerprinting.' },
  { key: 'personalization', locked: false,
    label: 'Personalization',
    description: 'Tailors what you see (examples, tips, content) to be more relevant. Off unless you turn it on.' },
  { key: 'marketing_email', locked: false,
    label: 'Email updates',
    description: 'Lets us follow up by email with product news and helpful tips. Off unless you opt in.' },
  { key: 'marketing_sms', locked: false,
    label: 'Text updates',
    description: 'Lets us text you occasional updates. Off unless you opt in.' },
];

/** Accept everything (all categories granted). */
export function presetAcceptAll(): ConsentState {
  const s = { ...DEFAULT_CONSENT };
  for (const c of CONSENT_CATEGORIES) s[c] = true;
  return s;
}

/** Reject everything optional — only `necessary` stays on. */
export function presetRejectNonEssential(): ConsentState {
  const s = { ...DEFAULT_CONSENT };
  for (const c of CONSENT_CATEGORIES) s[c] = false;
  s.necessary = true;
  return s;
}

/** Normalize any partial map into a full state (necessary forced on). */
export function normalizeState(partial: Partial<ConsentState>): ConsentState {
  const s = { ...DEFAULT_CONSENT, ...partial };
  s.necessary = true;
  return s;
}

/**
 * Whether to surface the banner. Shown only when the visitor has made no
 * explicit choice AND no GPC signal is present — GPC is itself a valid choice
 * (opt out of the governed categories), so we honor it silently rather than nag.
 * A visitor can always re-open the preference center from the footer.
 */
export function shouldShowBanner(opts: { decided: boolean; gpc: boolean }): boolean {
  return !opts.decided && !opts.gpc;
}

/** Extract acquisition params from a URL query string (for the track payload). */
export function parseUtmParams(search: string): { source: string | null; medium: string | null; campaign: string | null } {
  let sp: URLSearchParams;
  try { sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search); }
  catch { return { source: null, medium: null, campaign: null }; }
  const pick = (k: string) => { const v = sp.get(k)?.trim(); return v ? v.slice(0, 200) : null; };
  return {
    source: pick('utm_source') ?? pick('ref'),
    medium: pick('utm_medium'),
    campaign: pick('utm_campaign'),
  };
}
