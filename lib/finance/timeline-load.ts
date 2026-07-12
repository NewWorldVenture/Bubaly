// lib/finance/timeline-load.ts — server-side data loader for the Financial
// Copilot. Takes a Supabase client (so it's callable from both the page and the
// server actions) and fuses the finance + schedule tables into the pure
// buildCashflowTimeline() brain. No 'server-only' import: it holds no secrets,
// just orchestrates queries on whatever client it's handed.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  buildCashflowTimeline,
  type CashflowTimeline,
  type TimelineBill,
  type TimelineGoal,
  type TimelineEvent,
} from './timeline';

type Client = SupabaseClient<Database>;

/** Fetch bills + goals + upcoming events + balances and build the timeline. */
export async function loadMoneyTimeline(
  supabase: Client,
  familyId: string,
  now: Date = new Date(),
): Promise<CashflowTimeline> {
  const horizonEnd = new Date(now.getTime() + 13 * 7 * 86_400_000).toISOString();

  const [billsQ, goalsQ, acctQ, eventsQ] = await Promise.all([
    supabase.from('bills')
      .select('name, amount, due_date, is_recurring, recurrence, status, category')
      .eq('family_id', familyId).limit(1000),
    supabase.from('savings_goals')
      .select('name, target_amount, current_amount, target_date')
      .eq('family_id', familyId).limit(500),
    supabase.from('financial_accounts')
      .select('balance, type')
      .eq('family_id', familyId).limit(200),
    supabase.from('calendar_events')
      .select('title, starts_at')
      .eq('family_id', familyId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', horizonEnd)
      .order('starts_at').limit(500),
  ]);

  const bills = (billsQ.data ?? []) as TimelineBill[];
  const goals = (goalsQ.data ?? []) as TimelineGoal[];
  const events = (eventsQ.data ?? []) as TimelineEvent[];

  // Starting balance = sum of liquid (cash/checking/savings) accounts; fall back
  // to all accounts if none are typed. Credit/loan accounts are excluded so the
  // projection reflects spendable cash, not debt lines.
  const accounts = (acctQ.data ?? []) as { balance: number; type: string | null }[];
  const liquid = accounts.filter((a) => !a.type || ['checking', 'savings', 'cash'].includes(a.type));
  const pool = liquid.length ? liquid : accounts.filter((a) => (a.type ?? '') !== 'credit');
  const startingBalance = pool.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  return buildCashflowTimeline({ bills, goals, events, startingBalance, now });
}
