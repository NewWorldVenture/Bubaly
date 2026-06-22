import Link from 'next/link';
import { Megaphone } from 'lucide-react';

const SUBNAV = [
  ['/admin/marketing', 'Dashboard'],
  ['/admin/marketing/assistant', 'AI Assistant'],
  ['/admin/marketing/crm', 'CRM'],
  ['/admin/marketing/pipeline', 'Pipeline'],
  ['/admin/marketing/proposals', 'Proposals'],
  ['/admin/marketing/customers', 'Customers'],
  ['/admin/marketing/leads', 'Lead Scoring'],
  ['/admin/marketing/health', 'Customer Health'],
  ['/admin/marketing/segments', 'Segments'],
  ['/admin/marketing/campaigns', 'Campaigns'],
  ['/admin/marketing/email', 'Email'],
  ['/admin/marketing/sms', 'SMS'],
  ['/admin/marketing/social', 'Social'],
  ['/admin/marketing/ads', 'Ads'],
  ['/admin/marketing/automation', 'Automation'],
  ['/admin/marketing/experiments', 'A/B Testing'],
  ['/admin/marketing/referrals', 'Referrals'],
  ['/admin/marketing/surveys', 'Surveys'],
  ['/admin/marketing/reviews', 'Reviews'],
  ['/admin/marketing/funnels', 'Funnels'],
  ['/admin/marketing/landing-pages', 'Landing Pages'],
  ['/admin/marketing/forms', 'Forms'],
  ['/admin/marketing/content', 'Content'],
  ['/admin/marketing/seo', 'SEO'],
  ['/admin/marketing/aeo', 'AEO'],
  ['/admin/marketing/analytics', 'Analytics'],
  ['/admin/marketing/audit', 'Audit'],
  ['/admin/marketing/settings', 'Settings'],
] as const;

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-brand" />
        <h1 className="text-lg font-bold">Marketing</h1>
      </div>
      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-2">
        {SUBNAV.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg"
          >
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
