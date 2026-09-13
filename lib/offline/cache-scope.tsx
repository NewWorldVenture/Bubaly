'use client';

import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MemberRole } from '@/lib/constants/roles';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { getCacheSessionSnapshot, getServerCacheSessionSnapshot, subscribeCacheSession } from '@/lib/auth/cache-session';
import type { CachePartition } from './cache';
import { useTranslations } from '@/components/i18n/locale-provider';

export type CacheAccessIdentity = {
  userId: string; familyId: string; memberId: string; membershipUpdatedAt: string;
  role: MemberRole; isSuperAdmin: boolean; planLevel: number;
  featureTiers: Record<string, FeatureTier>;
};
export type AuthenticatedCacheScope = {
  status: 'pending' | 'ready' | 'unavailable' | 'blocked';
  key: string;
  partition: CachePartition | null;
  familyId: string;
  sessionRevision: number;
  error: string | null;
  familyMismatchError: string;
};
const Context = createContext<AuthenticatedCacheScope | null>(null);

export function cacheAccessKey(access: CacheAccessIdentity): string {
  return JSON.stringify([
    access.userId, access.familyId, access.memberId, access.membershipUpdatedAt,
    access.role, access.isSuperAdmin, access.planLevel,
    Object.entries(access.featureTiers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ]);
}

export function useAuthenticatedCacheScope(): AuthenticatedCacheScope | null { return useContext(Context); }

/** Synchronous commit fence, including the interval before React re-renders. */
export function isAuthenticatedCacheScopeCurrent(scope: AuthenticatedCacheScope): boolean {
  const current = getCacheSessionSnapshot();
  return scope.status === 'ready' && !!scope.partition && current.status === 'ready'
    && current.revision === scope.sessionRevision
    && current.identity?.userId === scope.partition.userId
    && current.identity?.sessionId === scope.partition.sessionId;
}

export function AuthenticatedCacheBoundary({ access, children }: { access: CacheAccessIdentity; children: ReactNode }) {
  const t = useTranslations();
  const session = useSyncExternalStore(subscribeCacheSession, getCacheSessionSnapshot, getServerCacheSessionSnapshot);
  const sessionStatus = session.status;
  const sessionUserId = session.identity?.userId ?? null;
  const sessionId = session.identity?.sessionId ?? null;
  const sessionRevision = session.revision;
  const observedUserId = session.observedUserId;
  const unavailableError = t('auth.cacheSessionUnavailable');
  const changedError = t('auth.cacheSessionChanged');
  const familyMismatchError = t('auth.cacheFamilyMismatch');
  const accessKey = cacheAccessKey(access);
  const agrees = sessionStatus === 'ready' && sessionUserId === access.userId && sessionId !== null;
  const blocked = sessionStatus === 'signed-out' || (observedUserId !== null && observedUserId !== access.userId);
  const confirmed = agrees ? `${sessionUserId}:${sessionId}` : null;
  const [lifetime, setLifetime] = useState({ accessKey, confirmed: null as string | null, blocked: false, epoch: 0 });
  let next = lifetime;
  const changedAccess = lifetime.accessKey !== accessKey;
  const changedSession = confirmed !== null && lifetime.confirmed !== null && confirmed !== lifetime.confirmed;
  const retired = blocked && !lifetime.blocked;
  const lostSessionIdentity = sessionStatus === 'unavailable' && lifetime.confirmed !== null;
  if (changedAccess || changedSession || retired || lostSessionIdentity) {
    next = { accessKey, confirmed, blocked, epoch: lifetime.epoch + 1 };
    setLifetime(next);
  } else if ((confirmed !== null && lifetime.confirmed === null) || blocked !== lifetime.blocked) {
    // First agreeing bootstrap records the session without remounting forms
    // already rendered against this server identity.
    next = { ...lifetime, confirmed: confirmed ?? lifetime.confirmed, blocked };
    setLifetime(next);
  }

  const scope = useMemo<AuthenticatedCacheScope>(() => {
    const partition = agrees && sessionId ? { userId: access.userId, sessionId, accessIdentity: accessKey } : null;
    const status = blocked ? 'blocked' : agrees ? 'ready' : sessionStatus === 'unavailable' ? 'unavailable' : 'pending';
    return {
      status, partition, familyId: access.familyId, sessionRevision,
      key: JSON.stringify([accessKey, partition?.sessionId ?? null, sessionRevision, status]),
      error: status === 'unavailable' ? unavailableError : status === 'blocked' ? changedError : null,
      familyMismatchError,
    };
  }, [access.userId, access.familyId, accessKey, agrees, blocked, sessionStatus, sessionId, sessionRevision, unavailableError, changedError, familyMismatchError]);

  return (
    <Context.Provider value={scope}>
      {blocked
        ? <div role="status">{changedError}</div>
        : <CacheLifetime key={`${accessKey}:${next.epoch}`}>{children}</CacheLifetime>}
    </Context.Provider>
  );
}

function CacheLifetime({ children }: { children: ReactNode }) { return <>{children}</>; }
