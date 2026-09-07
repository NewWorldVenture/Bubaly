'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, Loader2, Send } from 'lucide-react';
import { isNative } from '@/lib/native/capacitor';
import {
  webPushSupported, subscribeWebPush, unsubscribeWebPush, VAPID_PUBLIC_KEY,
} from '@/lib/push/web-client';
import { useTranslations } from '@/components/i18n/locale-provider';

type State = 'idle' | 'busy' | 'on' | 'unsupported' | 'denied' | 'unconfigured';

/**
 * Explicit opt-in for browser/PWA push notifications (first-time permission
 * prompts must be user-initiated). Native apps register automatically via
 * PushRegistrar, so this control hides inside the native shell.
 */
export function EnablePushButton() {
  const t = useTranslations();
  const [state, setState] = useState<State>('idle');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  async function sendTest() {
    setTesting(true);
    setTestMsg('');
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setTestMsg(data.error ?? 'Could not send test.');
      } else if (data.result?.sent > 0) {
        setTestMsg('Sent! Check this device for the notification.');
      } else if (data.result?.skipped > 0) {
        setTestMsg('No deliverable device yet — make sure push is enabled on this device.');
      } else {
        setTestMsg('No notification delivered (no active subscription found).');
      }
    } catch {
      setTestMsg('Network error sending test.');
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => {
    if (isNative()) { setState('on'); return; }
    if (!webPushSupported()) { setState('unsupported'); return; }
    if (!VAPID_PUBLIC_KEY) { setState('unconfigured'); return; }
    if (Notification.permission === 'denied') { setState('denied'); return; }
    if (Notification.permission === 'granted') { setState('on'); return; }
    setState('idle');
  }, []);

  async function enable() {
    setState('busy');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'idle'); return; }
    const payload = await subscribeWebPush();
    if (!payload) { setState('unsupported'); return; }
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    setState('on');
  }

  async function disable() {
    setState('busy');
    const endpoint = await unsubscribeWebPush();
    if (endpoint) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }),
      });
    }
    setState('idle');
  }

  if (isNative()) return null;

  if (state === 'unsupported' || state === 'unconfigured') {
    return (
      <p className="inline-flex items-center gap-2 text-xs text-muted">
        <BellOff className="h-3.5 w-3.5" />
        {state === 'unsupported' ? 'Push notifications aren’t supported in this browser.' : 'Push isn’t configured for this deployment yet.'}
      </p>
    );
  }
  if (state === 'denied') {
    return (
      <p className="inline-flex items-center gap-2 text-xs text-warning">
        <BellOff className="h-3.5 w-3.5" /> {t('enablePushButton.notificationsAreBlockedEnableThemIn')}
      </p>
    );
  }
  if (state === 'on') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <button onClick={sendTest} disabled={testing} className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60">
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t('enablePushButton.sendTestPush')}
          </button>
          <button onClick={disable} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-muted hover:text-fg">
            <BellRing className="h-4 w-4 text-success" /> {t('enablePushButton.onTurnOff')}
          </button>
        </div>
        {testMsg && <p className="text-xs text-muted">{testMsg}</p>}
      </div>
    );
  }
  return (
    <button onClick={enable} disabled={state === 'busy'} className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60">
      {state === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />} {t('enablePushButton.enablePushNotifications')}
    </button>
  );
}
