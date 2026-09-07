'use client';

import { useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Loader2, Save } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import {
  SOCIAL_PLATFORMS,
  normalizeSocialUrl,
  resolveSocialLinks,
  type SocialLinks,
  type SocialPlatform,
} from '@/lib/marketing/social-links';
import {
  FacebookIcon,
  InstagramIcon,
  LinkedinIcon,
  TiktokIcon,
  XIcon,
  YoutubeIcon,
  type SocialIconProps,
} from '@/components/brand/social-icons';
import { saveSocialLinksAction } from './actions';

const ICONS: Record<SocialPlatform, (p: SocialIconProps) => React.JSX.Element> = {
  facebook: FacebookIcon,
  youtube: YoutubeIcon,
  x: XIcon,
  instagram: InstagramIcon,
  linkedin: LinkedinIcon,
  tiktok: TiktokIcon,
};

export function SocialLinksForm({ links }: { links: SocialLinks }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  // What is currently typed, so the preview and the per-field validity below
  // track every keystroke rather than the last saved value.
  const [draft, setDraft] = useState<SocialLinks>(links);

  // The footer draws every platform, using a saved URL where there is one and
  // the brand default otherwise — so the preview does too, through the same
  // resolveSocialLinks the footer calls. `usingDefault` is what makes the
  // difference legible: an icon here is not proof that anyone configured it.
  const resolved = resolveSocialLinks(draft);
  const usingDefault = (key: (typeof SOCIAL_PLATFORMS)[number]['key']) =>
    !normalizeSocialUrl(draft[key]);

  async function onSubmit(formData: FormData) {
    setSaving(true);
    const res = await saveSocialLinksAction(formData);
    setSaving(false);
    if (!res.ok) {
      toastError(res.error);
      return;
    }
    setRejected(res.rejected);
    setDraft(res.saved);
    if (res.rejected.length) {
      toastError(t('socialLinksForm.savedButRejected', { fields: res.rejected.join(', ') }));
    } else {
      success(t('socialLinksForm.socialLinksUpdated'));
    }
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {SOCIAL_PLATFORMS.map(({ key, label, placeholder }) => {
        const typed = (draft[key] ?? '').trim();
        // Only complain about something actually typed — an empty field is a
        // deliberate "no account", not a mistake.
        const invalid = typed.length > 0 && !normalizeSocialUrl(typed);
        return (
          <label key={key} className="block">
            <span className="text-sm font-semibold">{label}</span>
            <input
              name={key}
              type="url"
              inputMode="url"
              value={draft[key] ?? ''}
              onChange={(e) => {
                setDraft((d) => ({ ...d, [key]: e.target.value }));
                // A field being edited is no longer the one the server rejected.
                setRejected((r) => r.filter((k) => k !== key));
              }}
              placeholder={placeholder}
              aria-invalid={invalid || rejected.includes(key)}
              className={`mt-1.5 h-11 w-full rounded-xl border bg-surface px-3 text-base focus-ring ${
                invalid || rejected.includes(key) ? 'border-danger' : 'border-border'
              }`}
            />
            {invalid && (
              <span className="mt-1 block text-xs text-danger">
                {t('socialLinksForm.mustBeHttpsUrl')}
              </span>
            )}
          </label>
        );
      })}

      <p className="text-xs text-muted">{t('socialLinksForm.fullHttpsUrlsOnlyClear')}</p>

      <div className="rounded-xl border border-border bg-surface/60 p-4">
        <p className="text-xs font-semibold text-muted">{t('socialLinksForm.footerPreview')}</p>
        <div className="mt-2 flex min-h-9 flex-wrap items-center gap-1">
          {SOCIAL_PLATFORMS.map(({ key, label }) => {
            const Icon = ICONS[key];
            const isDefault = usingDefault(key);
            return (
              <span
                key={key}
                title={`${label} — ${resolved[key]}`}
                className={`grid h-9 w-9 place-items-center rounded-full ${
                  isDefault ? 'text-muted/45' : 'text-muted'
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">{t('socialLinksForm.defaultsAreDimmed')}</p>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {t('socialLinksForm.saveSocialLinks')}
      </button>
    </form>
  );
}
