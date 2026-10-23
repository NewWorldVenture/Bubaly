import { Share2 } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { getSocialAccess } from '@/lib/social/access';
import { SOCIAL_SURFACES, canAnySocial, type SocialPermission } from '@/lib/social/roles';
import { SocialSubnav, type SubnavItem } from '@/components/social/subnav';
import { getTranslations } from '@/lib/i18n/server';

/** A section, and the permissions (any one) a social role needs to be shown it. */
const SECTIONS: (SubnavItem & { needs?: readonly SocialPermission[] })[] = [
  { href: '/dashboard/social', label: 'Overview' },
  { href: '/dashboard/social/feed', label: 'Feed' },
  { href: '/dashboard/social/content-studio', label: 'Content Studio', needs: SOCIAL_SURFACES.pipeline },
  { href: '/dashboard/social/posts', label: 'Posts', needs: SOCIAL_SURFACES.pipeline },
  { href: '/dashboard/social/calendar', label: 'Calendar', needs: SOCIAL_SURFACES.pipeline },
  { href: '/dashboard/social/analytics', label: 'Analytics', needs: SOCIAL_SURFACES.analytics },
  { href: '/dashboard/social/inbox', label: 'Inbox' },
  { href: '/dashboard/social/media-library', label: 'Media', needs: SOCIAL_SURFACES.media },
  { href: '/dashboard/social/accounts', label: 'Accounts' },
  { href: '/dashboard/social/settings', label: 'Settings' },
];

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  // The plan and the feature switch, for every page below. Only the overview
  // checked them, so a Free family (or any family once Social is switched off)
  // opened the other fifteen pages by URL. A server action does not pass
  // through a layout: actions.ts checks for itself.
  const ctx = await requireFeature('/dashboard/social');
  const access = await getSocialAccess(ctx.active.familyId);
  const sections: SubnavItem[] = SECTIONS
    .filter((section) => !section.needs || (access !== null && canAnySocial(access.can, section.needs)))
    .map(({ href, label }) => ({ href, label }));
  return (
    <div className="module-page">
      <div className="flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
          <Share2 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t('dashboardSocial.socialCommandCenter')}</h1>
          <p className="text-sm text-muted">{t('dashboardSocial.connectAccountsSeeOneUnifiedFeed')}</p>
        </div>
      </div>
      <SocialSubnav items={sections} />
      {children}
    </div>
  );
}
