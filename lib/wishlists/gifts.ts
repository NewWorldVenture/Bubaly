// lib/wishlists/gifts.ts — pure helpers for Wish Lists + gift coordination.
// The defining rule: a wish's OWNER must never see who claimed/bought their
// items (so gifts stay a surprise), while everyone else can. Kept free of
// Supabase/React so this privacy logic is deterministically unit-testable.

export type WishPriority = 'low' | 'medium' | 'high';

export interface WishLike {
  id: string;
  member_id: string;        // whose wish this is
  title: string;
  priority: WishPriority;
  claimed_by: string | null;
  is_purchased: boolean;
}

/** The owner may never see claim/purchase state on their own wishes. */
export function canSeeClaim(item: WishLike, viewerMemberId: string | null): boolean {
  return !!viewerMemberId && viewerMemberId !== item.member_id;
}

export type ClaimState = 'hidden' | 'unclaimed' | 'claimed_by_you' | 'claimed_by_other' | 'purchased';

/** Resolves what `viewer` is allowed to see about an item's claim status. */
export function claimState(item: WishLike, viewerMemberId: string | null): ClaimState {
  if (!canSeeClaim(item, viewerMemberId)) return 'hidden';
  if (item.is_purchased) return 'purchased';
  if (!item.claimed_by) return 'unclaimed';
  return item.claimed_by === viewerMemberId ? 'claimed_by_you' : 'claimed_by_other';
}

/** Only the claimer (or an unclaimed item) can be claimed/unclaimed by a viewer. */
export function canToggleClaim(item: WishLike, viewerMemberId: string | null): boolean {
  if (!canSeeClaim(item, viewerMemberId)) return false; // owner can't claim own
  return !item.claimed_by || item.claimed_by === viewerMemberId;
}

const PRIORITY_RANK: Record<WishPriority, number> = { high: 0, medium: 1, low: 2 };

/** Sorts by priority (high→low), unpurchased before purchased, then title. */
export function sortWishes<T extends WishLike>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.is_purchased !== b.is_purchased) return a.is_purchased ? 1 : -1;
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return a.title.localeCompare(b.title);
  });
}

/** Groups wishes by their owner member id. */
export function groupByMember<T extends WishLike>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of sortWishes(items)) {
    const arr = map.get(it.member_id) ?? [];
    arr.push(it);
    map.set(it.member_id, arr);
  }
  return map;
}

export const WISH_PRIORITY_LABELS: Record<WishPriority, string> = { low: 'Nice to have', medium: 'Would love', high: 'Really want' };
