'use client';

// Chief-of-Staff front door — the "Waiting on you" list with ONE-TAP decisions.
// Every row is the shared ApprovalCard (compact), so approving from Home runs
// through exactly the same service as the trust inbox: the payload executes,
// a parked run resumes, and the audit row is written once. Optimistic: a
// decided card leaves the list immediately; router.refresh() re-syncs the
// counts. Kids/guests see the list read-only (canDecide=false) — the server
// action re-enforces manager-only too.
//
// The Home page selects only `id, title, agent, priority` for the sample, so
// a row here may carry nothing but a title; anything richer the page passes
// (consequences, expiry, amount) renders when present.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { ApprovalCard } from '@/components/approvals/approval-card';
import type { ApprovalCardData } from '@/lib/approvals/card-data';
import type { FrontDoorPending } from '@/lib/home/front-door';
import { useTranslations } from '@/components/i18n/locale-provider';

export type PendingApprovalItem = FrontDoorPending & Partial<ApprovalCardData>;

/** Fill the card shape from whatever the caller had; the title is the only thing a row must have. */
export function toPendingCard(item: PendingApprovalItem): ApprovalCardData {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary ?? null,
    consequences: item.consequences ?? [],
    domain: item.domain ?? '',
    requestedBy: item.requestedBy ?? (item.agent ? 'Bubaly' : null),
    requestedAt: item.requestedAt ?? '',
    expiresAt: item.expiresAt ?? null,
    runId: item.runId ?? null,
    amountCents: item.amountCents ?? null,
    canEdit: item.canEdit ?? false,
    editableFields: item.editableFields ?? [],
    agent: item.agent ?? null,
    priority: item.priority ?? null,
    requiredApprovals: item.requiredApprovals,
    approvalsRecorded: item.approvalsRecorded,
    parentsOnly: item.parentsOnly,
  };
}

export function PendingApprovals({
  items, totalCount, canDecide,
}: {
  items: PendingApprovalItem[];
  totalCount: number;
  canDecide: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const rows = items.filter((p) => !gone.has(p.id));
  const remaining = Math.max(totalCount - gone.size, rows.length);

  if (rows.length === 0) {
    return <p className="text-sm text-muted">{t('pendingApprovals.allCaughtUpEveryRequestIs')}</p>;
  }

  return (
    <>
      <ul className="space-y-2">
        {rows.slice(0, 3).map((p) => (
          <li key={p.id}>
            <ApprovalCard
              approval={toPendingCard(p)}
              canDecide={canDecide}
              compact
              onResult={(result) => {
                if (result.decision !== 'pending') setGone((g) => new Set(g).add(p.id));
                router.refresh();
              }}
            />
          </li>
        ))}
      </ul>
      <Link href="/dashboard/trust" className="mt-2 inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-brand-text hover:underline coarse:min-h-11">
        {t('pendingApprovals.reviewAll')}{remaining > 3 ? ` (+${remaining - 3} more)` : ''} <ChevronRight className="h-3 w-3" aria-hidden />
      </Link>
    </>
  );
}
