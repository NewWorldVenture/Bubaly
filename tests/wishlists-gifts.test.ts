import { describe, it, expect } from 'vitest';
import {
  canSeeClaim, claimState, canToggleClaim, sortWishes, groupByMember, type WishLike,
} from '@/lib/wishlists/gifts';

const w = (over: Partial<WishLike>): WishLike => ({
  id: Math.random().toString(36).slice(2), member_id: 'kid', title: 'Lego', priority: 'medium',
  claimed_by: null, is_purchased: false, ...over,
});

describe('canSeeClaim', () => {
  it('hides claims from the wish owner, shows to others', () => {
    expect(canSeeClaim(w({ member_id: 'kid' }), 'kid')).toBe(false);
    expect(canSeeClaim(w({ member_id: 'kid' }), 'mom')).toBe(true);
    expect(canSeeClaim(w({ member_id: 'kid' }), null)).toBe(false);
  });
});

describe('claimState', () => {
  it('is always hidden for the owner', () => {
    expect(claimState(w({ member_id: 'kid', claimed_by: 'mom' }), 'kid')).toBe('hidden');
    expect(claimState(w({ member_id: 'kid', is_purchased: true }), 'kid')).toBe('hidden');
  });
  it('reflects claim status for non-owners', () => {
    expect(claimState(w({ member_id: 'kid', claimed_by: null }), 'mom')).toBe('unclaimed');
    expect(claimState(w({ member_id: 'kid', claimed_by: 'mom' }), 'mom')).toBe('claimed_by_you');
    expect(claimState(w({ member_id: 'kid', claimed_by: 'dad' }), 'mom')).toBe('claimed_by_other');
    expect(claimState(w({ member_id: 'kid', is_purchased: true, claimed_by: 'dad' }), 'mom')).toBe('purchased');
  });
});

describe('canToggleClaim', () => {
  it('lets a non-owner claim an unclaimed item or release their own', () => {
    expect(canToggleClaim(w({ member_id: 'kid', claimed_by: null }), 'mom')).toBe(true);
    expect(canToggleClaim(w({ member_id: 'kid', claimed_by: 'mom' }), 'mom')).toBe(true);
  });
  it('blocks claiming someone else\'s claim and blocks the owner', () => {
    expect(canToggleClaim(w({ member_id: 'kid', claimed_by: 'dad' }), 'mom')).toBe(false);
    expect(canToggleClaim(w({ member_id: 'kid', claimed_by: null }), 'kid')).toBe(false);
  });
});

describe('sortWishes', () => {
  it('orders by priority, unpurchased first, then title', () => {
    const out = sortWishes([
      w({ id: 'a', priority: 'low', title: 'Z' }),
      w({ id: 'b', priority: 'high', title: 'B' }),
      w({ id: 'c', priority: 'high', title: 'A' }),
      w({ id: 'd', priority: 'high', is_purchased: true, title: 'A' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('groupByMember', () => {
  it('buckets wishes per owner', () => {
    const g = groupByMember([w({ id: '1', member_id: 'kid' }), w({ id: '2', member_id: 'mom' }), w({ id: '3', member_id: 'kid' })]);
    expect(g.get('kid')!.length).toBe(2);
    expect(g.get('mom')!.length).toBe(1);
  });
});
