'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useApp } from '@/components/app/app-context';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Card } from '@/components/ui/card';
import { getEmailPreferenceAction, setEmailPreferenceAction } from '@/app/(app)/settings/notification-actions';

export function NotificationEmailPreference() {
  const { userId } = useApp();
  // An account change unmounts its state and cancels its visible completions.
  return <EmailPreferenceCard key={userId} userId={userId} />;
}

function EmailPreferenceCard({ userId }: { userId: string }) {
  const t = useTranslations();
  const translate = useRef(t);
  translate.current = t;
  const id = useId();
  const active = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setEnabled(null);
    setError(null);
    setSaved(false);
    try {
      const result = await getEmailPreferenceAction();
      if (!active.current || request !== sequence.current) return;
      if (!result.ok) { setError(result.error); return; }
      if (result.userId !== userId || typeof result.enabled !== 'boolean') {
        setError(translate.current('ai.accountContextIsTemporarilyUnavailable'));
        return;
      }
      setEnabled(result.enabled);
    } catch {
      if (active.current && request === sequence.current) setError(translate.current('assistantModule.somethingWentWrong'));
    } finally {
      if (active.current && request === sequence.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; };
  }, [load]);

  async function save(next: boolean) {
    if (pending.current || loading || enabled === null) return;
    pending.current = true;
    const request = ++sequence.current;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await setEmailPreferenceAction(next);
      if (!active.current || request !== sequence.current) return;
      if (!result.ok) { setError(result.error); return; }
      if (result.userId !== userId || result.enabled !== next) {
        setError(t('errors.thatChangeWasNotSaved'));
        return;
      }
      setEnabled(result.enabled);
      setSaved(true);
    } catch {
      if (active.current && request === sequence.current) setError(t('aiActions.couldNotSaveThoseSettings'));
    } finally {
      if (active.current && request === sequence.current) { pending.current = false; setSaving(false); }
    }
  }

  return (
    <Card aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="mb-3 text-base font-semibold">{t('notifications.notifications')}</h2>
      <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm">
        <input id={id} type="checkbox" checked={enabled === true} disabled={loading || saving || enabled === null}
          onChange={(event) => { void save(event.currentTarget.checked); }}
          aria-describedby={error ? `${id}-error` : undefined} className="h-5 w-5 accent-brand focus-ring" />
        {t('settings.email')}
      </label>
      {(loading || saving || saved) && <p role="status" className="mt-2 text-xs text-muted">
        {loading || saving ? t('states.loadingEllipsis') : t('aiSettings.saved')}
      </p>}
      {error && <div className="mt-2 flex flex-wrap items-center gap-3">
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p>
        <button type="button" disabled={loading || saving} onClick={() => { void load(); }}
          className="min-h-11 rounded-lg border border-border px-3 text-sm focus-ring disabled:opacity-50">
          {t('settings.tryAgain')}
        </button>
      </div>}
    </Card>
  );
}
