// lib/marketing/crm.ts — pure CRM/pipeline helpers (no Supabase/React).
// Stage definitions, grouping, and pipeline math are deterministic and
// unit-tested here; the admin pages/actions do the DB I/O.

export type LeadStatus = 'new' | 'working' | 'qualified' | 'unqualified' | 'customer';
export type LifecycleStage = 'subscriber' | 'lead' | 'mql' | 'sql' | 'opportunity' | 'customer' | 'evangelist';
export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';

export const LEAD_STATUSES: LeadStatus[] = ['new', 'working', 'qualified', 'unqualified', 'customer'];

export const LIFECYCLE_STAGES: LifecycleStage[] = ['subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist'];
export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  subscriber: 'Subscriber', lead: 'Lead', mql: 'MQL', sql: 'SQL',
  opportunity: 'Opportunity', customer: 'Customer', evangelist: 'Evangelist',
};

// Open pipeline stages in order, then the two terminal stages.
export const DEAL_STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
export const OPEN_DEAL_STAGES: DealStage[] = ['lead', 'qualified', 'proposal', 'negotiation'];
export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};

// Probability of closing by stage — drives weighted (expected) pipeline value.
export const DEAL_STAGE_PROBABILITY: Record<DealStage, number> = {
  lead: 0.1, qualified: 0.3, proposal: 0.6, negotiation: 0.8, won: 1, lost: 0,
};

export interface ContactLike {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/** Best available display name for a contact. */
export function contactDisplayName(c: ContactLike): string {
  const name = [c.first_name, c.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  return name || (c.email ?? 'Unknown contact');
}

export interface DealLike {
  id: string;
  stage: DealStage;
  amount_cents: number;
}

/** Groups deals by stage, preserving DEAL_STAGES order (empty arrays included). */
export function dealsByStage<T extends DealLike>(deals: T[]): Record<DealStage, T[]> {
  const grouped = {} as Record<DealStage, T[]>;
  for (const s of DEAL_STAGES) grouped[s] = [];
  for (const d of deals) (grouped[d.stage] ??= []).push(d);
  return grouped;
}

/** Total value (cents) of OPEN deals (excludes won/lost). */
export function openPipelineValueCents(deals: DealLike[]): number {
  return deals
    .filter((d) => (OPEN_DEAL_STAGES as string[]).includes(d.stage))
    .reduce((sum, d) => sum + (d.amount_cents || 0), 0);
}

/** Expected value (cents): each open deal's amount × its stage probability. */
export function weightedPipelineValueCents(deals: DealLike[]): number {
  return deals
    .filter((d) => (OPEN_DEAL_STAGES as string[]).includes(d.stage))
    .reduce((sum, d) => sum + Math.round((d.amount_cents || 0) * DEAL_STAGE_PROBABILITY[d.stage]), 0);
}

/** Total value (cents) of WON deals. */
export function wonValueCents(deals: DealLike[]): number {
  return deals.filter((d) => d.stage === 'won').reduce((sum, d) => sum + (d.amount_cents || 0), 0);
}

/** Win rate over closed deals (won / (won + lost)); 0 when none closed. */
export function winRate(deals: DealLike[]): number {
  const won = deals.filter((d) => d.stage === 'won').length;
  const lost = deals.filter((d) => d.stage === 'lost').length;
  const closed = won + lost;
  return closed === 0 ? 0 : won / closed;
}

/** Formats integer cents as a $ string (whole dollars). */
export function formatCents(cents: number): string {
  return `$${Math.round((cents || 0) / 100).toLocaleString('en-US')}`;
}
