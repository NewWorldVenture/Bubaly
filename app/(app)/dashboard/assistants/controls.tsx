'use client';

import { useState, useTransition } from 'react';
import { Copy, Check, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { createAssistantLinkAction, revokeAssistantLinkAction } from './actions';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

const PROVIDERS = [
  { value: 'alexa', label: 'Amazon Alexa' },
  { value: 'siri', label: 'Siri / Apple Shortcuts' },
  { value: 'google', label: 'Google Assistant' },
  { value: 'generic', label: 'Something else' },
];

export function NewAssistantKey() {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    start(async () => {
      const result = await createAssistantLinkAction(data);
      if (!result.ok) { error(result.error); return; }
      setIssued(result.token ?? null);
      setCopied(false);
      form.reset();
      success(result.message);
    });
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
    } catch {
      // Clipboard access is refused in some browsers and every embedded
      // webview. The key is on screen and selectable, so this is a convenience
      // failing, not the flow failing — say so rather than looking broken.
      error('Could not copy automatically. Select the key and copy it by hand.');
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">What is this for?</span>
          <input name="label" className={inputCls} placeholder="Kitchen Echo" required />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Assistant</span>
          <select name="provider" className={inputCls} defaultValue="alexa">
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="allowCapture" defaultChecked className="mt-0.5 accent-[var(--brand)]" />
          <span>
            <span className="font-medium">Let it add things</span>
            <span className="block text-xs text-muted">
              Tasks, events and shopping items. Turn this off for a speaker in a shared room — it will still
              read the day out.
            </span>
          </span>
        </label>
        <Button type="submit" loading={pending} className="w-full">Create key</Button>
      </form>

      {issued && (
        <div className="rounded-xl border border-brand/40 bg-brand/10 p-3">
          <p className="text-sm font-medium">Copy this now</p>
          <p className="mt-1 text-xs text-muted">
            It is stored only as a hash, so this is the one time it can be shown.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-surface/70 p-2 text-xs">{issued}</code>
          <Button size="sm" variant="secondary" className="mt-2" onClick={copy}>
            {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
          </Button>
        </div>
      )}
    </div>
  );
}

export function RevokeAssistantKey({ id }: { id: string }) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" loading={pending}
      onClick={() => start(async () => {
        const result = await revokeAssistantLinkAction(id);
        if (result.ok) success(result.message); else error(result.error);
      })}>
      <Trash2 className="h-4 w-4" /> Revoke
    </Button>
  );
}
