import type { Metadata } from 'next';
import { Activity, FileEdit, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty } from '@/components/family/shell';
import { describeTrail, type TrailRow } from '@/lib/activity/trail';
import { fmtRelative } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Activity' };
export const dynamic = 'force-dynamic';

export default async function FamilyActivityPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // `audit_logs.actor_id` is an auth user id, so the names come from the member
  // rows. The page selected `actor_id` from the start and never showed it —
  // "who changed what" was missing the who.
  const [{ data: logs }, { data: members }] = await Promise.all([
    supabase
      .from('audit_logs')
      .select('id, action, resource, resource_id, metadata, created_at, actor_id')
      .eq('family_id', ctx.active.familyId)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('family_members')
      .select('user_id, display_name')
      .eq('family_id', ctx.active.familyId),
  ]);

  const nameByUserId = new Map(
    (members ?? []).filter((m) => m.user_id && m.display_name).map((m) => [m.user_id as string, m.display_name as string]),
  );
  const lines = describeTrail((logs ?? []) as TrailRow[], nameByUserId);

  return (
    <div className="space-y-5">
      <PageHeader title={t('familyActivity.familyActivity')} description="A running log of changes across your household." />
      <SectionCard title={t('familyActivity.recentActivity')}>
        {lines.length > 0 ? (
          <ul className="space-y-1">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface/40">
                <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${l.byAssistant ? 'bg-brand-500/15' : 'bg-violet-500/15'}`}>
                  {l.byAssistant ? <Sparkles className="h-4 w-4 text-brand-text" /> : <FileEdit className="h-4 w-4 text-brand-text" />}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{l.who}</span>{' '}
                  <span className="text-muted">{l.what}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">{fmtRelative(l.at)}</span>
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={Activity} text="No activity recorded yet." />}
      </SectionCard>
    </div>
  );
}
