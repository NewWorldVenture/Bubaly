'use client';

import { useState, useTransition } from 'react';
import { Wand2, Loader2, Plus, ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { generatePlanAction, createChoreAction } from '../actions';
import type { ChorePlanItem } from '@/lib/chores/ai';

export function PlanGenerator({ members }: { members: { id: string; name: string }[] }) {
  const [prompt, setPrompt] = useState('');
  const [items, setItems] = useState<ChorePlanItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [added, setAdded] = useState<Set<number>>(new Set());

  function generate() {
    setError(null);
    start(async () => {
      const res = await generatePlanAction(prompt, []);
      if (res.error) setError(res.error);
      setItems(res.items);
      setAdded(new Set());
    });
  }

  function add(item: ChorePlanItem, idx: number) {
    const fd = new FormData();
    fd.set('title', item.title);
    fd.set('instructions', item.description);
    fd.set('difficulty', item.difficulty);
    fd.set('est_minutes', String(item.est_minutes));
    fd.set('points', String(item.suggested_points));
    fd.set('reward_mode', item.suggested_cash_cents > 0 ? 'fixed_cash' : 'fixed_points');
    if (item.suggested_cash_cents > 0) fd.set('cash_cents', String(item.suggested_cash_cents));
    fd.set('proof_required', item.proof_required);
    fd.set('safety_level', item.safety_level);
    fd.set('recurrence', item.recurrence);
    if (item.auto_approve_eligible) fd.set('auto_approve_score', '85');
    start(async () => {
      await createChoreAction(fd);
      setAdded((s) => new Set(s).add(idx));
    });
  }

  return (
    <Card className="border-brand/30 bg-brand/5">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wand2 className="h-4 w-4 text-brand-text" /> AI chore plan builder</h2>
      <p className="mb-3 text-xs text-muted">Describe your family and let AI suggest an age-appropriate, balanced plan.{members.length > 0 ? ` Kids: ${members.map((m) => m.name).join(', ')}.` : ''}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="Create a weekly chore plan for my 15, 13, and 10 year old"
          className="h-10 flex-1 rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring"
        />
        <button onClick={generate} disabled={pending || !prompt.trim()} className="inline-flex h-10 items-center justify-center gap-1 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg disabled:opacity-60">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Generate
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      {items.length > 0 && (
        <div className="mt-4 space-y-2">
          {items.map((item, idx) => (
            <div key={idx} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/60 p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{item.title}</p>
                  <Badge tone="neutral">{item.difficulty}</Badge>
                  {item.suggested_cash_cents > 0 ? <Badge tone="brand">${(item.suggested_cash_cents / 100).toFixed(2)}</Badge> : <Badge tone="brand">{item.suggested_points} pts</Badge>}
                  {item.safety_level !== 'none' && <Badge tone="danger"><ShieldAlert className="h-3 w-3" /> {item.safety_level === 'parent_required' ? 'Parent' : 'Caution'}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted">{item.description}</p>
                <p className="mt-0.5 text-[11px] text-muted">{item.recurrence} · {item.est_minutes} min · proof: {item.proof_required}{item.assignee_age != null ? ` · age ~${item.assignee_age}` : ''}</p>
              </div>
              <button onClick={() => add(item, idx)} disabled={pending || added.has(idx)} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium text-muted hover:text-fg disabled:opacity-60">
                {added.has(idx) ? 'Added ✓' : <><Plus className="h-3.5 w-3.5" /> Add</>}
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
