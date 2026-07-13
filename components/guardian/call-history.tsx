'use client';

import { useState } from 'react';
import { Search, Phone, MessageSquare, ChevronDown, ChevronUp, Play } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { TRUST_LABELS, TRUST_COLORS, TRUST_ICONS, type TrustLevel } from '@/lib/guardian/trust';
import { ROUTING_MODE_LABELS, type RoutingMode } from '@/lib/guardian/pipeline';
import { SCAM_TYPE_LABELS } from '@/lib/guardian/scam';
import { formatPhone } from '@/lib/guardian/phone';

type Communication = {
  id: string;
  comm_type: string;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  from_name: string | null;
  body: string | null;
  summary: string | null;
  sentiment: string | null;
  trust_level_at_time: TrustLevel | null;
  routing_mode_used: RoutingMode | null;
  ai_decision_reason: string | null;
  scam_detected: boolean;
  scam_type: string | null;
  scam_confidence: number | null;
  call_duration_secs: number | null;
  call_recording_url: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
};

const COMM_ICONS: Record<string, string> = {
  call_inbound: '📞',
  call_outbound: '📲',
  sms_inbound: '💬',
  sms_outbound: '📤',
  whatsapp_inbound: '💚',
  whatsapp_outbound: '📗',
  email_inbound: '📧',
};

const COMM_LABELS: Record<string, string> = {
  call_inbound: 'Inbound Call',
  call_outbound: 'Outbound Call',
  sms_inbound: 'Inbound Text',
  sms_outbound: 'Outbound Text',
  whatsapp_inbound: 'WhatsApp',
  email_inbound: 'Email',
};

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function CallHistory({ communications }: { communications: Communication[] }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'calls' | 'sms' | 'scams' | 'blocked'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = communications.filter((c) => {
    const q = search.toLowerCase();
    if (q) {
      const hay = [c.from_name, c.from_number, c.summary, c.body].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === 'calls' && !c.comm_type.startsWith('call')) return false;
    if (filter === 'sms' && !c.comm_type.startsWith('sms')) return false;
    if (filter === 'scams' && !c.scam_detected) return false;
    if (filter === 'blocked' && c.status !== 'blocked') return false;
    return true;
  });

  // Group by date
  const groups: Map<string, Communication[]> = new Map();
  for (const comm of filtered) {
    const date = new Date(comm.started_at).toDateString();
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(comm);
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search history…"
            className="h-10 w-full rounded-xl border border-border bg-bg pl-9 pr-3 text-sm"
          />
        </div>
        <div className="flex gap-1.5">
          {(['all', 'calls', 'sms', 'scams', 'blocked'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium capitalize transition',
                filter === f ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped list */}
      {groups.size === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 py-12 text-center text-sm text-muted">
          No communications match your filter.
        </div>
      ) : (
        Array.from(groups.entries()).map(([date, comms]) => (
          <div key={date} className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
            <div className="border-b border-border bg-surface/60 px-4 py-2">
              <p className="text-xs font-semibold text-muted uppercase tracking-wide">
                {new Date(date).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
            </div>
            <div className="divide-y divide-border">
              {comms.map((comm) => (
                <div key={comm.id}>
                  <button
                    className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface/60 transition"
                    onClick={() => setExpanded(expanded === comm.id ? null : comm.id)}
                  >
                    <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elevated text-base">
                      {comm.scam_detected ? '🚫' : COMM_ICONS[comm.comm_type] ?? '📱'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {comm.from_name ?? formatPhone(comm.from_number)}
                        </span>
                        {comm.trust_level_at_time && (
                          <span className={cn('text-xs shrink-0', TRUST_COLORS[comm.trust_level_at_time])}>
                            {TRUST_ICONS[comm.trust_level_at_time]}
                          </span>
                        )}
                        {comm.scam_detected && (
                          <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-400 shrink-0">
                            SCAM {comm.scam_confidence}%
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted mt-0.5 line-clamp-1">
                        {comm.summary ?? comm.body ?? COMM_LABELS[comm.comm_type] ?? 'Communication'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] text-muted">
                        {new Date(comm.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                      {comm.call_duration_secs != null && (
                        <p className="text-[10px] text-muted">{formatDuration(comm.call_duration_secs)}</p>
                      )}
                      {expanded === comm.id ? <ChevronUp className="ml-auto h-4 w-4 text-muted" /> : <ChevronDown className="ml-auto h-4 w-4 text-muted" />}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {expanded === comm.id && (
                    <div className="border-t border-border bg-elevated/50 px-4 py-3 space-y-2.5">
                      <DetailRow label="Type" value={COMM_LABELS[comm.comm_type] ?? comm.comm_type} />
                      {comm.trust_level_at_time && (
                        <DetailRow label="Trust" value={`${TRUST_ICONS[comm.trust_level_at_time]} ${TRUST_LABELS[comm.trust_level_at_time]}`} />
                      )}
                      {comm.routing_mode_used && (
                        <DetailRow label="Handling" value={ROUTING_MODE_LABELS[comm.routing_mode_used]} />
                      )}
                      {comm.ai_decision_reason && (
                        <DetailRow label="AI Reasoning" value={comm.ai_decision_reason} />
                      )}
                      {comm.scam_detected && (
                        <DetailRow
                          label="Scam Type"
                          value={`${SCAM_TYPE_LABELS[comm.scam_type ?? ''] ?? comm.scam_type} (${comm.scam_confidence}% confidence)`}
                          danger
                        />
                      )}
                      {comm.summary && <DetailRow label="Summary" value={comm.summary} />}
                      {comm.body && !comm.summary && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Message</p>
                          <p className="text-xs text-fg bg-surface rounded-lg p-2">{comm.body}</p>
                        </div>
                      )}
                      {comm.call_recording_url && (
                        <a
                          href={comm.call_recording_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 rounded-lg bg-brand/10 px-3 py-2 text-xs font-medium text-brand-text hover:bg-brand/20 transition w-fit"
                        >
                          <Play className="h-3.5 w-3.5" /> Play Recording
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function DetailRow({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted w-20 shrink-0 pt-0.5">{label}</span>
      <span className={cn('text-xs', danger ? 'text-red-400' : 'text-fg')}>{value}</span>
    </div>
  );
}
