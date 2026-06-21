import { Share2 } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { SocialSubnav, type SubnavItem } from '@/components/social/subnav';

const SECTIONS: SubnavItem[] = [
  { href: '/dashboard/social', label: 'Overview' },
  { href: '/dashboard/social/feed', label: 'Feed' },
  { href: '/dashboard/social/content-studio', label: 'Content Studio' },
  { href: '/dashboard/social/posts', label: 'Posts' },
  { href: '/dashboard/social/calendar', label: 'Calendar' },
  { href: '/dashboard/social/analytics', label: 'Analytics' },
  { href: '/dashboard/social/inbox', label: 'Inbox' },
  { href: '/dashboard/social/media-library', label: 'Media' },
  { href: '/dashboard/social/accounts', label: 'Accounts' },
  { href: '/dashboard/social/settings', label: 'Settings' },
];

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  await requireUserContext();
  return (
    <div className="module-page">
      <div className="flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Share2 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Social Command Center</h1>
          <p className="text-sm text-muted">Connect accounts, see one unified feed, create with AI, and publish everywhere.</p>
        </div>
      </div>
      <SocialSubnav items={SECTIONS} />
      {children}
    </div>
  );
}
