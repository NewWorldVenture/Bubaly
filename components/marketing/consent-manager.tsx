'use client';

// The real cookie-consent surface for the marketing site: a first-load banner
// (Accept all / Reject non-essential / Manage preferences) and a granular
// preference center wired to /api/mkt/consent. Honors GPC silently, feeds the
// resolved analytics flag to /api/mkt/track, and is re-openable from the footer.
// Replaces the old acknowledge-only cookie notice.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Cookie, ShieldCheck, X, Check, Lock } from 'lucide-react';
import type { ConsentState, ConsentCategory } from '@/lib/marketing/consent';
import {
  CONSENT_UI, presetAcceptAll, presetRejectNonEssential, shouldShowBanner,
} from '@/lib/marketing/consent-ui';
import {
  getAnonymousId, detectGPC, readLocalConsent, writeLocalConsent,
  initialConsent, postConsent, trackTouchOnce,
} from '@/lib/marketing/visitor';
import { useTranslations } from '@/components/i18n/locale-provider';

export const OPEN_CONSENT_EVENT = 'bubaly:open-consent';

export function ConsentManager() {
  const t = useTranslations();
  const [mounted, setMounted] = useState(false);
  const [gpc, setGpc] = useState(false);
  const [anonId, setAnonId] = useState('');
  const [decided, setDecided] = useState(true);       // assume decided until we check (no flash)
  const [bannerOpen, setBannerOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [draft, setDraft] = useState<ConsentState | null>(null);

  // Bootstrap from local cache + browser signals; fire the analytics touch.
  useEffect(() => {
    setMounted(true);
    const id = getAnonymousId();
    const isGpc = detectGPC();
    const local = readLocalConsent();
    const effective = local?.state ?? initialConsent(isGpc);
    const hasDecided = !!local?.decided;

    setAnonId(id);
    setGpc(isGpc);
    setDecided(hasDecided);
    setDraft(effective);
    setBannerOpen(shouldShowBanner({ decided: hasDecided, gpc: isGpc }));

    void trackTouchOnce(id, effective, isGpc);
  }, []);

  // Re-open the preference center from anywhere (footer link).
  useEffect(() => {
    const open = () => { setDraft((d) => d ?? initialConsent(detectGPC())); setPrefsOpen(true); };
    window.addEventListener(OPEN_CONSENT_EVENT, open);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, open);
  }, []);

  const commit = useCallback(async (state: ConsentState, source: string) => {
    writeLocalConsent(state, true);
    setDraft(state);
    setDecided(true);
    setBannerOpen(false);
    setPrefsOpen(false);
    // Durable server record + reconcile with the resolved state; then (re)fire
    // the analytics touch if the visitor just enabled analytics.
    const resolved = (await postConsent(anonId, state, gpc, source)) ?? state;
    writeLocalConsent(resolved, true);
    setDraft(resolved);
    void trackTouchOnce(anonId, resolved, gpc);
  }, [anonId, gpc]);

  if (!mounted || !draft) return null;

  return (
    <>
      {/* First-load banner */}
      {bannerOpen && !prefsOpen && (
        <div
          role="dialog"
          aria-label={t('consentManager.cookieConsent')}
          className="animate-fade-in-up fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-2xl border border-border bg-surface/95 p-4 shadow-glass backdrop-blur sm:inset-x-auto sm:right-4 sm:bottom-4 sm:p-5"
        >
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text">
              <Cookie className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t('consentManager.weValueYourPrivacy')}</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                We use strictly-necessary cookies to run Bubaly, plus optional first-party
                analytics to improve it. No ad trackers, no fingerprinting. Choose what you
                allow — see our{' '}
                <Link href="/cookies" className="font-medium text-brand-text hover:underline">{t('consentManager.cookiePolicy')}</Link>{' '}
                and{' '}
                <Link href="/privacy" className="font-medium text-brand-text hover:underline">{t('consentManager.privacyPolicy')}</Link>.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void commit(presetAcceptAll(), 'banner_accept_all')}
                  className="rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-brand-fg transition hover:opacity-90"
                >
                  {t('consentManager.acceptAll')}
                </button>
                <button
                  onClick={() => void commit(presetRejectNonEssential(), 'banner_reject')}
                  className="rounded-lg border border-border px-4 py-2 text-xs font-semibold transition hover:bg-elevated"
                >
                  {t('consentManager.rejectNonEssential')}
                </button>
                <button
                  onClick={() => setPrefsOpen(true)}
                  className="rounded-lg px-3 py-2 text-xs font-semibold text-muted transition hover:text-fg"
                >
                  {t('consentManager.managePreferences')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preference center */}
      {prefsOpen && (
        <PreferenceCenter
          initial={draft}
          gpc={gpc}
          onClose={() => { setPrefsOpen(false); if (!decided) setBannerOpen(true); }}
          onAcceptAll={() => void commit(presetAcceptAll(), 'prefs_accept_all')}
          onReject={() => void commit(presetRejectNonEssential(), 'prefs_reject')}
          onSave={(s) => void commit(s, 'prefs_save')}
        />
      )}
    </>
  );
}

function PreferenceCenter({
  initial, gpc, onClose, onAcceptAll, onReject, onSave,
}: {
  initial: ConsentState;
  gpc: boolean;
  onClose: () => void;
  onAcceptAll: () => void;
  onReject: () => void;
  onSave: (s: ConsentState) => void;
}) {
  const t = useTranslations();
  const [state, setState] = useState<ConsentState>(initial);
  const toggle = (key: ConsentCategory) => setState((s) => ({ ...s, [key]: !s[key], necessary: true }));

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-3 sm:items-center" role="dialog" aria-modal="true" aria-label={t('consentManager.privacyPreferences')}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="animate-fade-in-up relative w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-glass sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 text-brand-text"><ShieldCheck className="h-4 w-4" /></span>
            <h2 className="text-base font-bold">{t('consentManager.privacyPreferences')}</h2>
          </div>
          <button onClick={onClose} aria-label={t('consentManager.close')} className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>

        {gpc && (
          <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
            Your browser sends a Global Privacy Control signal — we’ve turned optional categories off by default. You can still turn them on below.
          </p>
        )}

        <div className="mt-4 space-y-2.5">
          {CONSENT_UI.map((c) => {
            const on = state[c.key];
            return (
              <div key={c.key} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg/40 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    {c.label}
                    {c.locked && <Lock className="h-3 w-3 text-muted" />}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-muted">{c.description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={c.label}
                  disabled={c.locked}
                  onClick={() => !c.locked && toggle(c.key)}
                  className={
                    'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ' +
                    (on ? 'bg-brand' : 'bg-border') + (c.locked ? ' cursor-not-allowed opacity-70' : '')
                  }
                >
                  <span className={'absolute top-0.5 grid h-5 w-5 place-items-center rounded-full bg-white transition-all ' + (on ? 'left-[22px]' : 'left-0.5')}>
                    {on && <Check className="h-3 w-3 text-brand-text" />}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button onClick={onReject} className="rounded-lg px-3 py-2 text-xs font-semibold text-muted transition hover:text-fg">
            {t('consentManager.rejectNonEssential')}
          </button>
          <button onClick={onAcceptAll} className="rounded-lg border border-border px-4 py-2 text-xs font-semibold transition hover:bg-elevated">
            {t('consentManager.acceptAll')}
          </button>
          <button onClick={() => onSave({ ...state, necessary: true })} className="rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-brand-fg transition hover:opacity-90">
            {t('consentManager.saveChoices')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Footer / anywhere trigger to re-open the preference center. */
export function ConsentReopenLink({ className }: { className?: string }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CONSENT_EVENT))}
      className={className ?? 'transition hover:text-fg'}
    >
      {t('consentManager.privacyChoices')}
    </button>
  );
}
