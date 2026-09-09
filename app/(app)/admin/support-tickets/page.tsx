import type { Metadata } from 'next';
import {
  ArrowDownToLine, CheckCircle2, Circle, Clock, Filter,
  Plus, TicketCheck, XCircle,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { TicketRowActions } from '@/components/admin/ticket-row-actions';
import { StatusDonut } from '@/components/admin/status-donut';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Support Tickets', robots: { index: false } };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

// `labelKey`, not `label`: 'supportTickets.unassigned' was a catalogue key in a
// field rendered verbatim, so that tab read back its own key.
const TABS = [
  { key: 'all',        labelKey: 'supportTickets.tab.all' },
  { key: 'mine',       labelKey: 'supportTickets.tab.mine' },
  { key: 'unassigned', labelKey: 'supportTickets.unassigned' },
  { key: 'open',       labelKey: 'supportTickets.tab.open' },
  { key: 'pending',    labelKey: 'supportTickets.tab.pending' },
  { key: 'resolved',   labelKey: 'supportTickets.tab.resolved' },
  { key: 'closed',     labelKey: 'supportTickets.tab.closed' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const CATEGORY_LABELS: Record<string, string> = {
  technical: 'Technical', billing: 'Billing', account: 'Account',
  family: 'Family', general: 'General', feature_request: 'Feature Request',
  // Contact-form topics (see lib/validation.ts CONTACT_TOPICS)
  bug: 'Bug', feature: 'Feature Request', feedback: 'Feedback',
  partnership: 'Partnership', other: 'Other',
};

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger', urgent: 'danger', medium: 'warning', low: 'neutral',
};

const STATUS_TONE: Record<string, 'success' | 'brand' | 'warning' | 'neutral'> = {
  open: 'brand', in_progress: 'warning', pending: 'neutral', resolved: 'success', closed: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In Progress', pending: 'Pending',
  resolved: 'Resolved', closed: 'Closed',
};

const CATEGORY_TONE: Record<string, 'brand' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  account: 'brand', billing: 'warning', family: 'success', technical: 'danger',
  general: 'neutral', feature_request: 'neutral',
  bug: 'danger', feature: 'brand', feedback: 'success', partnership: 'brand', other: 'neutral',
};

const STATUS_COLORS: Record<string, string> = {
  open: '#60a5fa', in_progress: '#fb923c', pending: '#fbbf24',
  resolved: '#34d399', closed: '#94a3b8',
};

type Params = {
  searchParams: Promise<{
    tab?: string; q?: string; status?: string; priority?: string;
    category?: string; agent?: string; page?: string;
  }>;
};

export default async function SupportTicketsPage({ searchParams }: Params) {
  const tr = await getTranslations();
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'all';
  const supabase = createServiceClient();

  const { data: allTickets, error: ticketsError } = await supabase
    .from('support_tickets')
    .select('*')
    .order('updated_at', { ascending: false });
  if (ticketsError) {
    console.error('[admin-support-tickets] ticket read failed', ticketsError);
    return <AdminReadError />;
  }

  const tickets = allTickets ?? [];

  // ── Stats ─────────────────────────────────────────────────────────
  const total      = tickets.length;
  const openCount  = tickets.filter((t) => t.status === 'open').length;
  const inProgress = tickets.filter((t) => t.status === 'in_progress').length;
  const pending    = tickets.filter((t) => t.status === 'pending').length;
  const resolved   = tickets.filter((t) => t.status === 'resolved').length;
  const closed     = tickets.filter((t) => t.status === 'closed').length;

  // Unique agents
  const agentNames = [...new Set(
    tickets.map((t) => t.assigned_agent_name).filter(Boolean) as string[],
  )].sort();

  // Top categories
  const categoryCounts = new Map<string, number>();
  for (const t of tickets) categoryCounts.set(t.category, (categoryCounts.get(t.category) ?? 0) + 1);
  const topCategories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);

  // ── Filter & paginate ─────────────────────────────────────────────
  const q            = (sp.q ?? '').trim().toLowerCase();
  const statusFilter = sp.status ?? '';
  const priorityFilter = sp.priority ?? '';
  const categoryFilter = sp.category ?? '';
  const agentFilter  = sp.agent ?? '';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  let filtered = tickets;

  // Tab-level filter
  if (tab === 'unassigned') filtered = filtered.filter((t) => !t.assigned_agent_id && !t.assigned_agent_name);
  else if (tab !== 'all' && tab !== 'mine') filtered = filtered.filter((t) => t.status === tab);

  // Column filters
  if (q) filtered = filtered.filter((t) => {
    const hay = `${t.subject} ${t.requester_name ?? ''} ${t.requester_email} ${t.ticket_number}`.toLowerCase();
    return hay.includes(q);
  });
  if (statusFilter)   filtered = filtered.filter((t) => t.status === statusFilter);
  if (priorityFilter) filtered = filtered.filter((t) => t.priority === priorityFilter);
  if (categoryFilter) filtered = filtered.filter((t) => t.category === categoryFilter);
  if (agentFilter)    filtered = filtered.filter((t) => t.assigned_agent_name === agentFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const hiddenParams = Object.fromEntries(
    Object.entries({ tab, q: sp.q, status: sp.status, priority: sp.priority, category: sp.category, agent: sp.agent })
      .filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  const donutSegments = [
    { label: 'Open',        count: openCount,  color: STATUS_COLORS.open },
    { label: 'In Progress', count: inProgress, color: STATUS_COLORS.in_progress },
    { label: 'Pending',     count: pending,    color: STATUS_COLORS.pending },
    { label: 'Resolved',    count: resolved,   color: STATUS_COLORS.resolved },
    { label: 'Closed',      count: closed,     color: STATUS_COLORS.closed },
  ];

  return (
    <div className="module-page">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminSupportTickets.supportTickets')}</h1>
          <p className="mt-1 text-sm text-muted">{tr('adminSupportTickets.manageAndResolveCustomerSupportRequests')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 text-sm font-medium hover:bg-elevated">
            <ArrowDownToLine className="h-4 w-4" /> {tr('adminSupportTickets.export')}
          </button>
          <button className="flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-fg hover:brightness-110">
            <Plus className="h-4 w-4" /> {tr('adminSupportTickets.newTicket')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/support-tickets?tab=${t.key}`}
            className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {tr(t.labelKey)}
          </a>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* Left: table */}
        <div className="space-y-5">
          <Card>
            {/* Filter bar */}
            <FilterForm action="/admin/support-tickets" hidden={{ tab }}>
              <FilterSearchInput name="q" defaultValue={sp.q} placeholder={tr('adminSupportTickets.searchTickets')} />
              <FilterSelect name="status" defaultValue={statusFilter} options={[
                { value: '', label: 'All Status' },
                { value: 'open',        label: 'Open' },
                { value: 'in_progress', label: 'In Progress' },
                { value: 'pending',     label: 'Pending' },
                { value: 'resolved',    label: 'Resolved' },
                { value: 'closed',      label: 'Closed' },
              ]} />
              <FilterSelect name="priority" defaultValue={priorityFilter} options={[
                { value: '', label: 'All Priority' },
                { value: 'urgent', label: 'Urgent' },
                { value: 'high',   label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low',    label: 'Low' },
              ]} />
              <FilterSelect name="category" defaultValue={categoryFilter} options={[
                { value: '', label: 'All Categories' },
                ...Object.entries(CATEGORY_LABELS).map(([v, l]) => ({ value: v, label: l })),
              ]} />
              <FilterSelect name="agent" defaultValue={agentFilter} options={[
                { value: '', label: 'All Agents' },
                ...agentNames.map((n) => ({ value: n, label: n })),
              ]} />
              <button type="submit" className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 text-sm hover:bg-elevated">
                <Filter className="h-4 w-4" /> {tr('adminSupportTickets.filters')}
              </button>
            </FilterForm>

            {pageRows.length === 0 ? (
              <div className="mt-6"><EmptyState icon={TicketCheck} title={tr('adminSupportTickets.noTicketsMatchTheseFilters')} /></div>
            ) : (
              <div className="table-responsive mt-4">
                <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.ticketId')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.subject')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.requester')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.category')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.priority')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.status')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.agent')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.updated')}</th>
                      <th className="px-3 py-2 font-medium">{tr('adminSupportTickets.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {pageRows.map((ticket) => (
                      <tr key={ticket.id} className="hover:bg-elevated/40 transition-colors">
                        <td className="px-3 py-2.5">
                          <span className="font-mono text-xs text-muted">{ticket.ticket_number}</span>
                        </td>
                        <td className="px-3 py-2.5 max-w-[200px]">
                          <p className="truncate font-medium">{ticket.subject}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <AvatarInitials name={ticket.requester_name ?? ticket.requester_email} size={28} />
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium">{ticket.requester_name ?? '—'}</p>
                              <p className="truncate text-[11px] text-muted">{ticket.requester_email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={CATEGORY_TONE[ticket.category] ?? 'neutral'}>
                            {CATEGORY_LABELS[ticket.category] ?? ticket.category}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={PRIORITY_TONE[ticket.priority] ?? 'neutral'}>
                            {ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={STATUS_TONE[ticket.status] ?? 'neutral'}>
                            {STATUS_LABEL[ticket.status] ?? ticket.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          {ticket.assigned_agent_name ? (
                            <div className="flex items-center gap-2">
                              <AvatarInitials name={ticket.assigned_agent_name} size={24} />
                              <span className="text-xs">{ticket.assigned_agent_name}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted/60 italic">{tr('supportTickets.unassigned')}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                          <p>{fmtDate(ticket.updated_at, 'MMM d, yyyy')}</p>
                          <p>{fmtDate(ticket.updated_at, 'hh:mm a')}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <TicketRowActions ticketId={ticket.id} status={ticket.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>
            )}

            {/* Pagination */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
              <span>
                {tr('adminSupportTickets.showing')} {filtered.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to{' '}
                {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} tickets
              </span>
              <div className="flex items-center gap-1">
                {pageSafe > 1 && (
                  <a href={`/admin/support-tickets?${new URLSearchParams({ ...hiddenParams, page: String(pageSafe - 1) })}`}
                    className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">‹</a>
                )}
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  const p = totalPages <= 7 ? i + 1 : pageSafe <= 4 ? i + 1 : Math.max(1, pageSafe - 3) + i;
                  if (p > totalPages) return null;
                  return (
                    <a key={p} href={`/admin/support-tickets?${new URLSearchParams({ ...hiddenParams, page: String(p) })}`}
                      className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                      {p}
                    </a>
                  );
                })}
                {totalPages > 7 && pageSafe < totalPages - 3 && (
                  <>
                    <span className="px-1">…</span>
                    <a href={`/admin/support-tickets?${new URLSearchParams({ ...hiddenParams, page: String(totalPages) })}`}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium hover:bg-elevated">
                      {totalPages}
                    </a>
                  </>
                )}
                {pageSafe < totalPages && (
                  <a href={`/admin/support-tickets?${new URLSearchParams({ ...hiddenParams, page: String(pageSafe + 1) })}`}
                    className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">›</a>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Right: sidebar stats */}
        <div className="space-y-5">
          {/* Tickets Overview */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">{tr('adminSupportTickets.ticketsOverview')}</h2>
              <span className="text-xs text-muted">{tr('adminSupportTickets.thisWeek')}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <OverviewStat icon={TicketCheck} label={tr('adminSupportTickets.total')}       value={total}      color="text-brand-text    bg-brand/10" />
              <OverviewStat icon={Circle}      label={tr('adminSupportTickets.open')}        value={openCount}  color="text-blue-400 bg-blue-500/10" />
              <OverviewStat icon={Clock}       label={tr('adminSupportTickets.inProgress')} value={inProgress} color="text-orange-400 bg-orange-500/10" />
              <OverviewStat icon={Circle}      label={tr('adminSupportTickets.pending')}     value={pending}    color="text-yellow-400 bg-yellow-500/10" />
              <OverviewStat icon={CheckCircle2} label={tr('adminSupportTickets.resolved')}   value={resolved}   color="text-success  bg-success/10" />
              <OverviewStat icon={XCircle}     label={tr('adminSupportTickets.closed')}      value={closed}     color="text-muted    bg-elevated" />
            </div>
          </Card>

          {/* Tickets by Status donut */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{tr('adminSupportTickets.ticketsByStatus')}</h2>
              <span className="text-xs text-muted">{tr('adminSupportTickets.thisWeek')}</span>
            </div>
            <StatusDonut segments={donutSegments} total={total} centerLabel="Total" />
          </Card>

          {/* Top Categories */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">{tr('adminSupportTickets.topCategories')}</h2>
              <span className="text-xs text-muted">{tr('adminSupportTickets.thisWeek')}</span>
            </div>
            <ul className="space-y-2.5">
              {topCategories.slice(0, 5).map(([cat, count]) => (
                <li key={cat} className="flex items-center justify-between text-sm">
                  <span className="text-muted">{CATEGORY_LABELS[cat] ?? cat}</span>
                  <span className="font-semibold">{count}</span>
                </li>
              ))}
            </ul>
            <a href="/admin/support-tickets?tab=all" className="mt-4 flex items-center gap-1 text-xs text-brand-text hover:underline">
              {tr('adminSupportTickets.viewAllCategories')}
            </a>
          </Card>

          {/* Quick Actions */}
          <Card>
            <h2 className="mb-3 text-base font-semibold">{tr('adminSupportTickets.quickActions')}</h2>
            <ul className="space-y-1">
              {[
                [Plus,          'New Support Ticket',  '/admin/support-tickets'],
                [TicketCheck,   'View Knowledge Base', '/admin/content'],
                [CheckCircle2,  'Customer Feedback',   '/admin/reports'],
                [Filter,        'Support Settings',    '/admin/security'],
              ].map(([Icon, label, href]) => (
                <li key={label as string}>
                  <a href={href as string}
                    className="flex items-center justify-between rounded-lg px-2 py-2.5 text-sm hover:bg-elevated">
                    <span className="flex items-center gap-2 text-muted">
                      {/* @ts-expect-error dynamic icon */}
                      <Icon className="h-4 w-4" /> {label}
                    </span>
                    <span className="text-muted/50">›</span>
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

async function AdminReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('supportTickets.supportTickets')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('supportTickets.manageAndResolveCustomerSupport')}</p>
      </div>
      <ErrorState message={tr('supportTickets.couldNotLoadSupportTickets')} />
      <a href="/admin/support-tickets" className="text-sm font-medium text-brand-text underline">{tr('supportTickets.refreshTickets')}</a>
    </div>
  );
}

function OverviewStat({
  icon: Icon, label, value, color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: number; color: string;
}) {
  const [iconColor, bgColor] = color.split(' ');
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/40 p-3">
      <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${bgColor}`}>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </span>
      <div>
        <p className="text-lg font-bold leading-none">{value.toLocaleString()}</p>
        <p className="mt-0.5 text-[11px] text-muted">{label}</p>
      </div>
    </div>
  );
}

function AvatarInitials({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
  const colors = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500', 'bg-rose-500', 'bg-amber-500'];
  const color = colors[name.charCodeAt(0) % colors.length];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-fg ${color}`}
      style={{ width: size, height: size, fontSize: size * 0.35 }}
    >
      {initials || '?'}
    </span>
  );
}
