'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';
import { startCalendarConnectionAction, previewConnectedCalendarAction } from '@/app/onboarding/calendar-actions';
import type { BriefEvent, FirstBrief } from '@/lib/onboarding/first-brief';
import { isReviewPlan, type ReviewPlan } from '@/lib/billing/review-selection';
import type { OnboardingOwner } from '@/lib/onboarding/owner';

export type CalendarProvider = 'google' | 'microsoft';
type Preview = { events: BriefEvent[]; receipt: string; calendarName: string; brief: FirstBrief };
export function ConnectedCalendar({ providers, accountId, status, family, displayName, onPreview, reviewPlan, expectedOwner }: {
  providers: CalendarProvider[]; accountId?: string; status?: string;
  family: { name: string; timezone: string }; displayName: string; onPreview: (preview: Preview) => void;
  reviewPlan?: ReviewPlan | null; expectedOwner?: OnboardingOwner;
}) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const screenKey = `${expectedOwner?.userId ?? ''}:${expectedOwner?.familyId ?? ''}:${reviewPlan ?? ''}`;
  const currentScreen = useRef(screenKey);
  currentScreen.current = screenKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    if (!accountId) return;
    const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      const result = await previewConnectedCalendarAction(accountId);
      if (!mounted.current || currentScreen.current !== screenKey || generation.current !== current) return;
      if (!result.ok) { setError(result.error); return; }
      onPreview(result.data);
    } catch { if (generation.current === current) setError(t('connectedCalendar.unavailable')); }
    finally { if (generation.current === current) setBusy(false); }
  }, [accountId, onPreview, t, screenKey]);
  useEffect(() => {
    const pendingGeneration = generation;
    void load();
    return () => { pendingGeneration.current++; };
  }, [load]);

  async function connect(provider: CalendarProvider) {
    if (!mounted.current || currentScreen.current !== screenKey || busy) return;
    const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      const input = { provider, family, displayName };
      const result = expectedOwner || isReviewPlan(reviewPlan)
        ? await startCalendarConnectionAction(input, { expectedOwner, ...(isReviewPlan(reviewPlan) ? { reviewPlan } : {}) })
        : await startCalendarConnectionAction(input);
      if (!mounted.current || currentScreen.current !== screenKey || generation.current !== current) return;
      if (!result.ok) { setError(result.error); return; }
      window.location.assign(result.url);
    } catch { if (mounted.current && currentScreen.current === screenKey && generation.current === current) setError(t('connectedCalendar.unavailable')); }
    finally { if (mounted.current && currentScreen.current === screenKey && generation.current === current) setBusy(false); }
  }
  if (!providers.length && !accountId) return null;
  return <section className="space-y-3 rounded-2xl border border-border p-4">
    <h2 className="text-sm font-semibold">{t('connectedCalendar.title')}</h2>
    <p className="text-sm text-muted">{t('connectedCalendar.description')}</p>
    <p className="text-xs text-muted">{t('connectedCalendar.setupNote')}</p>
    <div className="flex flex-wrap gap-2">
      {providers.map((provider) => <Button key={provider} variant="secondary" disabled={busy}
        onClick={() => void connect(provider)}>{t(provider === 'google' ? 'connectedCalendar.google' : 'connectedCalendar.microsoft')}</Button>)}
    </div>
    {busy && <p role="status" className="text-sm text-muted">{t('connectedCalendar.loading')}</p>}
    {(error || status === 'unavailable' || status === 'cancelled') && <p role="alert" className="text-sm text-danger">
      {error ?? t(status === 'cancelled' ? 'connectedCalendar.cancelled' : 'connectedCalendar.unavailable')}
    </p>}
    {accountId && error && <Button variant="ghost" disabled={busy} onClick={() => void load()}>{t('connectedCalendar.retry')}</Button>}
  </section>;
}
