'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, Loader2, Send } from 'lucide-react';
import { isNative } from '@/lib/native/capacitor';
import {
  webPushSupported, subscribeWebPush, unsubscribeWebPush, VAPID_PUBLIC_KEY,
} from '@/lib/push/web-client';
import { useTranslations } from '@/components/i18n/locale-provider';
import { forgetPushDevice, rememberPushDevice } from '@/lib/push/device-registration';

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
  const [pushError, setPushError] = useState('');

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

  /** The route's own (translated) error, or ours when it sent none. */
  async function routeError(res: Response, fallbackKey: string): Promise<string> {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    return typeof body?.error === 'string' && body.error ? body.error : t(fallbackKey);
  }

  // "On" means the server holds this device. /api/push/subscribe refuses a
  // device it cannot scope or save (503, 500), one whose endpoint it will not
  // POST to (400) and a flood (429) — so the client is not told it worked
  // (C1-S9-39). This button ignored the answer and said "On" anyway, and a
  // rejected fetch left it spinning on "busy" for good.
  async function enable() {
    setState('busy');
    setPushError('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'idle'); return; }
      const payload = await subscribeWebPush();
      if (!payload) { setState('unsupported'); return; }
      const res = await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (res.ok) rememberPushDevice(payload);
      else {
        setPushError(await routeError(res, 'enablePushButton.couldNotTurnOn'));
        setState('idle');
        return;
      }
      setState('on');
    } catch {
      setPushError(t('enablePushButton.couldNotTurnOn'));
      setState('idle');
    }
  }

  async function disable() {
    setState('busy');
    setPushError('');
    try {
      const endpoint = await unsubscribeWebPush();
      forgetPushDevice();
      if (endpoint) {
        const res = await fetch('/api/push/unsubscribe', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }),
        });
        // The browser has let go of the subscription, but the server still
        // holds the device and may keep sending to it: say so, not "Off".
        if (!res.ok) {
          setPushError(await routeError(res, 'enablePushButton.couldNotTurnOff'));
          setState('on');
          return;
        }
      }
      setState('idle');
    } catch {
      setPushError(t('enablePushButton.couldNotTurnOff'));
      setState('on');
    }
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
        {pushError && <p role="alert" className="text-xs text-danger">{pushError}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={enable} disabled={state === 'busy'} className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60">
        {state === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />} {t('enablePushButton.enablePushNotifications')}
      </button>
      {pushError && <p role="alert" className="text-xs text-danger">{pushError}</p>}
    </div>
  );
}
