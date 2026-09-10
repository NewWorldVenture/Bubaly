import type { Metadata } from 'next';
import { LifeBuoy, Inbox, Clock, CheckCircle2, Archive } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { TicketStatusControl } from '@/components/admin/ticket-status-control';
import { fmtDate } from '@/lib/utils/format';
import type { TicketStatus } from '@/app/(app)/admin/actions';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('support.supportTickets'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

type Params = { searchParams: Promise<{ q?: string; status?: string }> };

export default async function AdminSupportPage({ searchParams }: Params) {
  const tr = await getTranslations();
  const sp = await searchParams;
  const supabase = createServiceClient();

  const { data: tickets, error: ticketsError } = await supabase
    .from('support_tickets')
    .select('*')
    .order('created_at', { ascending: false });
  if (ticketsError) {
    console.error('[admin-support] ticket read failed', ticketsError);
    return <AdminReadError />;
  }

  const rows = tickets ?? [];
  const counts = { open: 0, pending: 0, resolved: 0, closed: 0 };
  for (const t of rows) if (t.status in counts) counts[t.status as keyof typeof counts]++;

  const q = (sp.q ?? '').trim().toLowerCase();
  const statusFilter = sp.status ?? '';
  const filtered = rows.filter((t) => {
    if (statusFilter && t.status !== statusFilter) return false;
    if (q && !`${t.requester_name ?? ''} ${t.requester_email} ${t.subject} ${t.description ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminSupport.supportTickets')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminSupport.messagesFromTheContactFormWith')}</p>
      </div>

      <div className="grid-stats">
        <StatCard icon={Inbox} label={tr('adminSupport.open')} value={counts.open} tone="bg-warning/10 text-warning" />
        <StatCard icon={Clock} label={tr('adminSupport.pending')} value={counts.pending} tone="bg-accent/10 text-accent" />
        <StatCard icon={CheckCircle2} label={tr('adminSupport.resolved')} value={counts.resolved} tone="bg-success/10 text-success" />
        <StatCard icon={Archive} label={tr('adminSupport.closed')} value={counts.closed} tone="bg-brand/10 text-brand-text" />
      </div>

      <Card>
        <FilterForm action="/admin/support" hidden={{}}>
          <FilterSearchInput name="q" defaultValue={sp.q} placeholder={tr('adminSupport.searchByNameEmailOrMessage')} />
          <FilterSelect name="status" defaultValue={statusFilter} options={[
            { value: '', label: 'All Statuses' },
            { value: 'open', label: 'Open' },
            { value: 'pending', label: 'Pending' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'closed', label: 'Closed' },
          ]} />
        </FilterForm>

        {filtered.length === 0 ? (
          <EmptyState icon={LifeBuoy} title={rows.length === 0 ? 'No support tickets yet' : 'No tickets match these filters'} description={rows.length === 0 ? 'Messages sent through the contact form will appear here.' : undefined} />
        ) : (
          <ul className="mt-4 space-y-3">
            {filtered.map((t) => (
              <li key={t.id} className="rounded-xl border border-border bg-surface/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{t.subject || 'Contact message'}</p>
                    <p className="text-xs text-muted">{t.requester_name || 'Anonymous'} · {t.requester_email} · {fmtDate(t.created_at, 'MMM d, yyyy h:mm a')}</p>
                  </div>
                  <TicketStatusControl ticketId={t.id} status={t.status as TicketStatus} />
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted">{t.description}</p>
                <div className="mt-2 flex items-center gap-2">
                  <a href={`mailto:${t.requester_email}?subject=Re: ${encodeURIComponent(t.subject || 'Your message to Bubaly')}`} className="text-xs font-medium text-brand-text hover:underline">{tr('support.replyByEmail')}</a>
                  <span className="text-xs text-muted">· via {t.tags.includes('contact-form') ? 'contact form' : t.category}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

async function AdminReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('support.supportTickets')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('support.messagesFromTheContactForm')}</p>
      </div>
      <ErrorState message={tr('support.couldNotLoadSupportTickets')} />
      <a href="/admin/support" className="text-sm font-medium text-brand-text underline">{tr('support.refreshTickets')}</a>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{value.toLocaleString()}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
