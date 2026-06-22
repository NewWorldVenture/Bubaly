import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { REWARD_MODE_LABELS } from '@/lib/chores/logic';
import { createChoreAction } from '../actions';
import { PlanGenerator } from './plan-generator';

export const metadata: Metadata = { title: 'New mission' };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const labelCls = 'space-y-1';
const spanCls = 'block text-xs font-medium text-muted';

export default async function NewMissionPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: members } = await supabase
    .from('family_members').select('id, display_name, birthday').eq('family_id', ctx.active.familyId).eq('is_active', true).order('display_name');
  const kids = members ?? [];

  return (
    <div className="space-y-5">
      <Link href="/missions" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> Back to missions</Link>

      <PlanGenerator members={kids.map((m) => ({ id: m.id, name: m.display_name }))} />

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Plus className="h-4 w-4 text-brand" /> Create a mission</h2>
        <form action={createChoreAction} className="grid gap-3 sm:grid-cols-2">
          <label className={`${labelCls} sm:col-span-2`}><span className={spanCls}>Title</span><input name="title" required className={inputCls} placeholder="e.g. Make your bed" /></label>
          <label className={`${labelCls} sm:col-span-2`}><span className={spanCls}>Instructions</span><input name="instructions" className={inputCls} placeholder="How to do it well" /></label>

          <fieldset className="sm:col-span-2">
            <span className={spanCls}>Assign to</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {kids.length === 0 ? <p className="text-sm text-muted">Add family members first.</p> : kids.map((m) => (
                <label key={m.id} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm">
                  <input type="checkbox" name="member_ids" value={m.id} className="h-4 w-4 rounded border-border" /> {m.display_name}
                </label>
              ))}
            </div>
          </fieldset>

          <label className={labelCls}><span className={spanCls}>Difficulty</span>
            <select name="difficulty" defaultValue="medium" className={inputCls}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>Estimated minutes</span><input type="number" name="est_minutes" min="1" className={inputCls} placeholder="15" /></label>

          <label className={labelCls}><span className={spanCls}>Reward mode</span>
            <select name="reward_mode" defaultValue="fixed_points" className={inputCls}>
              {Object.entries(REWARD_MODE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className={labelCls}><span className={spanCls}>Points (fixed)</span><input type="number" name="points" min="0" defaultValue={10} className={inputCls} /></label>
          <label className={labelCls}><span className={spanCls}>Points range min</span><input type="number" name="points_min" min="0" className={inputCls} placeholder="AI mode" /></label>
          <label className={labelCls}><span className={spanCls}>Points range max</span><input type="number" name="points_max" min="0" className={inputCls} placeholder="AI mode" /></label>
          <label className={labelCls}><span className={spanCls}>Cash cents (fixed)</span><input type="number" name="cash_cents" min="0" className={inputCls} placeholder="e.g. 300 = $3" /></label>
          <label className={labelCls}><span className={spanCls}>Cash min / max (cents)</span>
            <div className="flex gap-2"><input type="number" name="cash_min_cents" min="0" className={inputCls} placeholder="min" /><input type="number" name="cash_max_cents" min="0" className={inputCls} placeholder="max" /></div>
          </label>

          <label className={labelCls}><span className={spanCls}>Proof required</span>
            <select name="proof_required" defaultValue="none" className={inputCls}><option value="none">None</option><option value="photo">Photo</option><option value="video">Video</option><option value="before_after">Before &amp; after</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>Safety level</span>
            <select name="safety_level" defaultValue="none" className={inputCls}><option value="none">None</option><option value="caution">Caution</option><option value="parent_required">Parent required</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>Recurrence</span>
            <select name="recurrence" defaultValue="none" className={inputCls}><option value="none">One-time</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>Auto-approve at score (blank = always parent)</span><input type="number" name="auto_approve_score" min="0" max="100" className={inputCls} placeholder="e.g. 85" /></label>
          <label className={labelCls}><span className={spanCls}>Due date</span><input type="datetime-local" name="due_at" className={inputCls} /></label>
          <label className={labelCls}><span className={spanCls}>Icon (emoji)</span><input name="icon" maxLength={4} className={inputCls} placeholder="🧹" /></label>

          <div className="sm:col-span-2"><button className="inline-flex h-10 items-center gap-1 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Sparkles className="h-4 w-4" /> Create mission</button></div>
        </form>
      </Card>
    </div>
  );
}
