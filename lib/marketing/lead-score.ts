// Pure lead-scoring logic — unit tested, no dependencies.
// Scores inbound leads (contact-form tickets) so the team can prioritize follow-up.

export type LeadBand = 'hot' | 'warm' | 'cold';

export type LeadInput = {
  createdAt: string;
  status: string;          // new | open | pending | resolved | closed
  message: string | null;  // ticket description
  name: string | null;
  /** True if the email already maps to an existing family/customer. */
  isCustomer: boolean;
};

export type LeadScore = {
  score: number;       // 0..100
  band: LeadBand;
  ageDays: number;
  reasons: string[];
};

const DAY = 86_400_000;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const OPEN = new Set(['new', 'open', 'pending']);

export function bandFor(score: number): LeadBand {
  if (score >= 70) return 'hot';
  if (score >= 45) return 'warm';
  return 'cold';
}

export const LEAD_BAND_LABEL: Record<LeadBand, string> = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };

export function scoreLead(input: LeadInput, now: number = Date.now()): LeadScore {
  const reasons: string[] = [];
  const t = new Date(input.createdAt).getTime();
  const ageDays = Number.isNaN(t) ? 999 : Math.max(0, Math.floor((now - t) / DAY));
  let score = 40;

  // Recency — fresh leads convert best.
  if (ageDays <= 2) { score += 30; reasons.push('Brand new (<2 days)'); }
  else if (ageDays <= 7) { score += 20; reasons.push('Recent (<1 week)'); }
  else if (ageDays <= 30) { score += 5; }
  else { score -= 10; reasons.push('Going stale (>30 days)'); }

  // Engagement — a substantive message signals real intent.
  const len = (input.message ?? '').trim().length;
  if (len >= 200) { score += 15; reasons.push('Detailed message'); }
  else if (len >= 60) { score += 8; }

  // Status — only open leads are actionable.
  if (OPEN.has(input.status)) { score += 10; }
  else { score -= 20; reasons.push('Already closed/resolved'); }

  if (input.name) score += 5;

  if (input.isCustomer) reasons.push('Existing customer');

  score = clamp(Math.round(score));
  return { score, band: bandFor(score), ageDays, reasons };
}

export type LeadSummary = { total: number; hot: number; warm: number; cold: number; open: number };

export function summarizeLeads(scores: { band: LeadBand; status: string }[]): LeadSummary {
  const out: LeadSummary = { total: 0, hot: 0, warm: 0, cold: 0, open: 0 };
  for (const s of scores) {
    out.total++;
    out[s.band]++;
    if (OPEN.has(s.status)) out.open++;
  }
  return out;
}
