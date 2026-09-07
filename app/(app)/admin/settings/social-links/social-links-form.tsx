'use client';

import { useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Loader2, Save } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { SOCIAL_PLATFORMS, type SocialLinks } from '@/lib/marketing/social-links';
import { saveSocialLinksAction } from './actions';

export function SocialLinksForm({ links }: { links: SocialLinks }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  async function onSubmit(formData: FormData) {
    setSaving(true);
    const res = await saveSocialLinksAction(formData);
    setSaving(false);
    if (!res.ok) {
      toastError(res.error);
      return;
    }
    setRejected(res.rejected);
    if (res.rejected.length) {
      toastError(`Saved, but ${res.rejected.join(', ')} was not a valid https URL and is not published.`);
    } else {
      success(t('socialLinksForm.socialLinksUpdated'));
    }
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {SOCIAL_PLATFORMS.map(({ key, label, placeholder }) => (
        <label key={key} className="block">
          <span className="text-sm font-semibold">{label}</span>
          <input
            name={key}
            type="url"
            inputMode="url"
            defaultValue={links[key] ?? ''}
            placeholder={placeholder}
            className={`mt-1.5 h-11 w-full rounded-xl border bg-surface px-3 text-base focus-ring ${
              rejected.includes(key) ? 'border-danger' : 'border-border'
            }`}
          />
        </label>
      ))}

      <p className="text-xs text-muted">{t('socialLinksForm.fullHttpsUrlsOnlyClear')}</p>

      <button
        type="submit"
        disabled={saving}
        className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save social links
      </button>
    </form>
  );
}
