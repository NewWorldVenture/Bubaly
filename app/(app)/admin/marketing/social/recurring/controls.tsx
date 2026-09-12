'use client';

import { useState, useTransition } from 'react';
import { Play, Pause, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  createRecurringAdAction, deleteRecurringAdAction,
  runRecurringAdNowAction, setRecurringAdStatusAction,
} from './actions';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

/** Pause / resume / post now / remove, for one campaign. */
export function RecurringAdControls({ id, status, finished }: { id: string; status: 'active' | 'paused'; finished: boolean }) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();

  const run = (work: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) => {
    start(async () => {
      const result = await work();
      if (result.ok) success(result.message ?? 'Done.');
      else error(result.error);
    });
  };

  return (
    <div className="flex flex-wrap gap-2">
      {!finished && (
        <Button size="sm" variant="secondary" loading={pending}
          onClick={() => run(() => setRecurringAdStatusAction(id, status === 'active' ? 'paused' : 'active'))}>
          {status === 'active' ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Resume</>}
        </Button>
      )}
      <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => runRecurringAdNowAction(id))}>
        <Send className="h-4 w-4" /> Post now
      </Button>
      <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => deleteRecurringAdAction(id))}>
        <Trash2 className="h-4 w-4" /> Remove
      </Button>
    </div>
  );
}

export type PlatformChoice = { value: string; label: string; ready: boolean };

/** The create form. Submits to the server action and reports its answer inline. */
export function NewRecurringAdForm({ platforms, cadences }: { platforms: PlatformChoice[]; cadences: readonly string[] }) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  const [cadence, setCadence] = useState('weekly');
  const needsDays = cadence === 'weekly' || cadence === 'biweekly';
  // The browser's own zone is the right default: whoever is setting this up is
  // almost always thinking in their local time.
  const [timezone] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    start(async () => {
      const result = await createRecurringAdAction(data);
      if (result.ok) { success(result.message ?? 'Campaign scheduled.'); form.reset(); setCadence('weekly'); }
      else error(result.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Campaign name</span>
        <input name="name" className={inputCls} placeholder="Weekly feature spotlight" required />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Messages</span>
        <textarea name="variants" rows={4} className="w-full rounded-xl border border-border bg-surface/60 p-3 text-sm focus-ring"
          placeholder={'One message per line.\nEach run takes the next one, then starts over.'} required />
        <span className="mt-1 block text-xs text-muted">Rotated in order, so a long campaign does not repeat itself.</span>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Link <span className="text-muted">(optional)</span></span>
        <input name="link" type="url" className={inputCls} placeholder="https://www.bubaly.com/features" />
      </label>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Platforms</legend>
        <div className="flex flex-wrap gap-2">
          {platforms.map((p) => (
            <label key={p.value} className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-2.5 py-1.5 text-xs">
              <input type="checkbox" name="platforms" value={p.value} className="accent-[var(--brand)]" />
              {p.label}
              {!p.ready && <span className="text-muted">· needs setup</span>}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Repeats</span>
          <select name="cadence" className={inputCls} value={cadence} onChange={(e) => setCadence(e.target.value)}>
            {cadences.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">At</span>
          <input name="times" className={inputCls} defaultValue="09:00" placeholder="09:00, 17:30" required />
        </label>
      </div>

      {needsDays && (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">On</legend>
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, index) => (
              <label key={label} className="flex items-center gap-1 rounded-lg border border-border bg-surface/40 px-2 py-1 text-xs">
                <input type="checkbox" name="daysOfWeek" value={index} className="accent-[var(--brand)]" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {cadence === 'monthly' && (
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Day of month</span>
          <input name="dayOfMonth" type="number" min={1} max={31} className={inputCls} defaultValue={1} />
          <span className="mt-1 block text-xs text-muted">A day the month does not have falls back to its last day.</span>
        </label>
      )}

      <input type="hidden" name="timezone" value={timezone} />
      <p className="text-xs text-muted">Times are in {timezone}. They stay put across daylight-saving changes.</p>

      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Starts <span className="text-muted">(optional)</span></span>
          <input name="startsAt" type="datetime-local" className={inputCls} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Ends <span className="text-muted">(optional)</span></span>
          <input name="endsAt" type="datetime-local" className={inputCls} />
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium">Stop after <span className="text-muted">(optional)</span></span>
        <input name="maxOccurrences" type="number" min={1} className={inputCls} placeholder="Leave blank to run indefinitely" />
      </label>

      <Button type="submit" loading={pending} className="w-full">Schedule campaign</Button>
    </form>
  );
}
