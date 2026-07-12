'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';

// Grouped so the ~40 marketing surfaces wrap into labelled rows — no horizontal
// scroll, everything clickable in one place, and mobile-friendly (chips wrap).
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Overview',
    items: [
      ['/admin/marketing', 'Dashboard'],
      ['/admin/marketing/assistant', 'AI Assistant'],
      ['/admin/marketing/analytics', 'Analytics'],
      ['/admin/marketing/audit', 'Audit'],
      ['/admin/marketing/settings', 'Settings'],
    ],
  },
  {
    title: 'CRM & Sales',
    items: [
      ['/admin/marketing/crm', 'CRM'],
      ['/admin/marketing/pipeline', 'Pipeline'],
      ['/admin/marketing/proposals', 'Proposals'],
      ['/admin/marketing/customers', 'Customers'],
      ['/admin/marketing/leads', 'Lead Scoring'],
      ['/admin/marketing/health', 'Customer Health'],
    ],
  },
  {
    title: 'Audience & Intelligence',
    items: [
      ['/admin/marketing/intelligence', 'Intelligence'],
      ['/admin/marketing/visitor-intelligence', 'Visitor Funnel'],
      ['/admin/marketing/lead-scores', 'Lead Scores'],
      ['/admin/marketing/segments', 'Segments'],
      ['/admin/marketing/personalization', 'Personalization'],
      ['/admin/marketing/competitive', 'Competitive'],
    ],
  },
  {
    title: 'Channels',
    items: [
      ['/admin/marketing/campaigns', 'Campaigns'],
      ['/admin/marketing/email', 'Email'],
      ['/admin/marketing/sms', 'SMS'],
      ['/admin/marketing/push', 'Push'],
      ['/admin/marketing/social', 'Social'],
      ['/admin/marketing/ads', 'Ads'],
      ['/admin/marketing/automation', 'Automation'],
      ['/admin/marketing/experiments', 'A/B Testing'],
    ],
  },
  {
    title: 'Growth',
    items: [
      ['/admin/marketing/referrals', 'Referrals'],
      ['/admin/marketing/affiliates', 'Affiliates'],
      ['/admin/marketing/funnels', 'Funnels'],
      ['/admin/marketing/landing-pages', 'Landing Pages'],
      ['/admin/marketing/exit-intent', 'Exit-Intent'],
      ['/admin/marketing/forms', 'Forms'],
    ],
  },
  {
    title: 'Content & SEO',
    items: [
      ['/admin/marketing/content', 'Content'],
      ['/admin/marketing/assets', 'Assets'],
      ['/admin/marketing/video', 'Video'],
      ['/admin/marketing/seo', 'SEO'],
      ['/admin/marketing/aeo', 'AEO'],
    ],
  },
  {
    title: 'Reputation & Loyalty',
    items: [
      ['/admin/marketing/reviews', 'Reviews'],
      ['/admin/marketing/reputation', 'Reputation'],
      ['/admin/marketing/surveys', 'Surveys'],
      ['/admin/marketing/loyalty', 'Loyalty'],
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/admin/marketing') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MarketingSubnav() {
  const pathname = usePathname() ?? '';
  return (
    <nav className="space-y-2 rounded-2xl border border-border bg-surface/30 p-3">
      {GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
          <span className="shrink-0 pt-1 text-[10px] font-bold uppercase tracking-wider text-muted/70 sm:w-32">
            {group.title}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {group.items.map(([href, label]) => {
              const active = isActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-xs font-medium transition',
                    active
                      ? 'bg-brand text-white'
                      : 'bg-elevated/60 text-muted hover:bg-elevated hover:text-fg',
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
