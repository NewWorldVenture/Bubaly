'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { AppLockGate } from '@/components/app/app-lock-gate';
import { getAppLockSettings } from '@/app/(app)/settings/app-lock-actions';
import { acceptAppUnlock, readAppLockIntent, requestAppLock, subscribeAppLock, type AppLockIntent } from '@/lib/security/app-lock-browser';
import { clearAllCache } from '@/lib/offline/cache';

function openLockScreen(): void {
  if (window.location.pathname === '/app-lock') return;
  window.location.replace(`/app-lock?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

/**
 * Server privacy checks decide which children are sent. This boundary retires
 * an already delivered page when its lock state changes. Once retired, it
 * cannot remount those children, including during router/history restoration.
 */
export function AppLockBoundary({ userId, enabled, locked, children, returnTo }: {
  userId: string; enabled: boolean; locked: boolean; children?: ReactNode; returnTo?: string;
}) {
  const [intent, setIntent] = useState<AppLockIntent | null>(null);
  const [retired, setRetired] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [checkUnavailable, setCheckUnavailable] = useState(false);
  const checking = useRef(false);

  useLayoutEffect(() => {
    let active = true;
    const existing = readAppLockIntent(userId);
    setIntent(existing?.phase === 'pending' ? { ...existing, phase: 'unavailable' } : existing);
    if (enabled && existing && existing.phase !== 'unlocked' && existing.phase !== 'changed') {
      setRetired(true);
    }
    // Protected routes refuse locked POST requests too. The standalone page
    // is where PIN checks and lock retries can reach their server actions.
    if (locked) openLockScreen();
    const retire = () => {
      clearAllCache();
      flushSync(() => setRetired(true));
    };
    const unsubscribe = subscribeAppLock(next => {
      if (next.userId !== userId) return;
      retire();
      flushSync(() => { setIntent(next); setRechecking(false); setCheckUnavailable(false); });
      if (next.phase === 'changed') window.location.reload();
      if (next.phase === 'locked') openLockScreen();
    });
    const onHide = () => { if (enabled) retire(); };
    const onShow = (event: PageTransitionEvent) => { if (event.persisted && enabled) { retire(); window.location.reload(); } };
    const onFocus = async () => {
      const before = readAppLockIntent(userId);
      if (!enabled || locked || checking.current || document.visibilityState === 'hidden'
        || (before && before.phase !== 'unlocked' && before.phase !== 'changed')) return;
      checking.current = true;
      retire();
      flushSync(() => { setRechecking(true); setCheckUnavailable(false); });
      try {
        const status = await getAppLockSettings();
        if (!active) return;
        if ((readAppLockIntent(userId)?.id ?? null) !== (before?.id ?? null)) return;
        if (status.ok) window.location.reload();
        else openLockScreen();
        // A refusal means the server now requires the PIN. Retained children
        // stay retired; no refresh result can remount their old subtree.
      } catch {
        // A blocked action or offline request cannot confirm this document.
        // Keep the escape and an explicit retry without navigating offline.
        if (active) setCheckUnavailable(true);
      } finally {
        checking.current = false;
        if (active) setRechecking(false);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
      else void onFocus();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [userId, enabled, locked]);

  if (!locked && !retired) return children;
  const blocked = rechecking || checkUnavailable || intent?.phase === 'pending' || intent?.phase === 'unavailable';
  return <AppLockGate key={`${userId}:${intent?.id ?? 'server'}`} blocked={blocked}
    unavailable={checkUnavailable || intent?.phase === 'unavailable'}
    onRetry={() => {
      if (window.location.pathname !== '/app-lock') openLockScreen();
      else void requestAppLock(userId);
    }}
    onUnlocked={() => {
      if (!acceptAppUnlock(userId, intent?.id ?? null)) return;
      if (returnTo) window.location.replace(returnTo);
      else window.location.reload();
    }} />;
}
