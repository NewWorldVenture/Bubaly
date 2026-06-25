// lib/wallet/wallet-ai.ts — pure AI helpers for the Family Wallet.

import type { AllocationRule, BucketLike, TxnLike } from './ledger';
import { fmtMoney, bucketLabel, totalBalance, walletSummary } from './ledger';

export interface WalletAnalysis {
  totalBalance: string;
  bucketBreakdown: Array<{ bucket: string; balance: string; pct: number }>;
  topBucket: string | null;
  goalsOnTrack: number;
  goalsBehind: number;
  recentActivity: number;
}

export function analyzeWallet(
  buckets: BucketLike[],
  txns: TxnLike[],
  memberId: string,
): WalletAnalysis {
  const summary = walletSummary(buckets, memberId, txns);
  const goalsOnTrack = summary.goalProgress.filter((g) => g.pct >= 50).length;
  const goalsBehind = summary.goalProgress.filter((g) => g.pct < 50).length;
  const recentTxns = txns.filter((t) => t.member_id === memberId).slice(0, 30);

  return {
    totalBalance: fmtMoney(summary.totalCents),
    bucketBreakdown: summary.byBucket.map((b) => ({
      bucket: bucketLabel(b.bucket),
      balance: fmtMoney(b.cents),
      pct: b.pct,
    })),
    topBucket: summary.topBucket ? bucketLabel(summary.topBucket) : null,
    goalsOnTrack,
    goalsBehind,
    recentActivity: recentTxns.length,
  };
}

export interface WalletAIResponse {
  advice: string;
  suggestions: string[];
}

export function buildWalletPrompt(
  analysis: WalletAnalysis,
  rules: AllocationRule[],
  memberName: string,
): { system: string; user: string } {
  const ruleStr = rules.length > 0
    ? rules.map((r) => `${bucketLabel(r.bucket)}: ${r.pct}%`).join(', ')
    : 'Default: Save 50%, Spend 30%, Give 10%, Invest 10%';

  return {
    system: `You are a family financial coach helping a child or teen manage their wallet.
Be encouraging and age-appropriate. Focus on building good money habits.
Return ONLY valid JSON: {"advice":"<2-3 sentences>","suggestions":["<suggestion 1>","<suggestion 2>","<suggestion 3>"]}`,
    user: `${memberName}'s wallet:
- Total balance: ${analysis.totalBalance}
- Buckets: ${analysis.bucketBreakdown.map((b) => `${b.bucket} ${b.balance} (${b.pct}%)`).join(', ')}
- Allocation: ${ruleStr}
- Goals on track: ${analysis.goalsOnTrack}, behind: ${analysis.goalsBehind}
- Recent transactions: ${analysis.recentActivity}

Give personalized financial coaching advice and 3 actionable suggestions.`,
  };
}

export function parseWalletResponse(raw: string): WalletAIResponse {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        advice: typeof parsed.advice === 'string' ? parsed.advice : '',
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions.filter((s: unknown): s is string => typeof s === 'string').slice(0, 5)
          : [],
      };
    }
  } catch { /* fallthrough */ }
  return { advice: raw.trim().slice(0, 500), suggestions: [] };
}
