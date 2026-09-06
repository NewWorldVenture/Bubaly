import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { REWARD_MODE_LABELS } from '@/lib/chores/logic';
import { createChoreAction } from '../actions';
import { PlanGenerator } from './plan-generator';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'New mission' };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const labelCls = 'space-y-1';
const spanCls = 'block text-xs font-medium text-muted';

export default async function NewMissionPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: members } = await supabase
    .from('family_members').select('id, display_name, birthday').eq('family_id', ctx.active.familyId).eq('is_active', true).order('display_name');
  const kids = members ?? [];

  return (
    <div className="space-y-5">
      <Link href="/missions" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> {t('missionsNew.backToMissions')}</Link>

      <PlanGenerator members={kids.map((m) => ({ id: m.id, name: m.display_name }))} />

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Plus className="h-4 w-4 text-brand-text" /> {t('missionsNew.createAMission')}</h2>
        <form action={createChoreAction} className="grid gap-3 sm:grid-cols-2">
          <label className={`${labelCls} sm:col-span-2`}><span className={spanCls}>{t('missionsNew.title')}</span><input name="title" required className={inputCls} placeholder={t('missionsNew.eGMakeYourBed')} /></label>
          <label className={`${labelCls} sm:col-span-2`}><span className={spanCls}>{t('missionsNew.instructions')}</span><input name="instructions" className={inputCls} placeholder={t('missionsNew.howToDoItWell')} /></label>

          <fieldset className="sm:col-span-2">
            <span className={spanCls}>{t('missionsNew.assignTo')}</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {kids.length === 0 ? <p className="text-sm text-muted">{t('missionsNew.addFamilyMembersFirst')}</p> : kids.map((m) => (
                <label key={m.id} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm">
                  <input type="checkbox" name="member_ids" value={m.id} className="h-4 w-4 rounded border-border" /> {m.display_name}
                </label>
              ))}
            </div>
          </fieldset>

          <label className={labelCls}><span className={spanCls}>{t('missionsNew.difficulty')}</span>
            <select name="difficulty" defaultValue="medium" className={inputCls}><option value="easy">{t('missionsNew.easy')}</option><option value="medium">{t('missionsNew.medium')}</option><option value="hard">{t('missionsNew.hard')}</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.estimatedMinutes')}</span><input type="number" name="est_minutes" min="1" className={inputCls} placeholder="15" /></label>

          <label className={labelCls}><span className={spanCls}>{t('missionsNew.rewardMode')}</span>
            <select name="reward_mode" defaultValue="fixed_points" className={inputCls}>
              {Object.entries(REWARD_MODE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.pointsFixed')}</span><input type="number" name="points" min="0" defaultValue={10} className={inputCls} /></label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.pointsRangeMin')}</span><input type="number" name="points_min" min="0" className={inputCls} placeholder={t('missionsNew.aiMode')} /></label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.pointsRangeMax')}</span><input type="number" name="points_max" min="0" className={inputCls} placeholder={t('missionsNew.aiMode')} /></label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.cashCentsFixed')}</span><input type="number" name="cash_cents" min="0" className={inputCls} placeholder={t('missionsNew.eG3003')} /></label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.cashMinMaxCents')}</span>
            <div className="flex gap-2"><input type="number" name="cash_min_cents" min="0" className={inputCls} placeholder="min" /><input type="number" name="cash_max_cents" min="0" className={inputCls} placeholder="max" /></div>
          </label>

          <label className={labelCls}><span className={spanCls}>{t('missionsNew.proofRequired')}</span>
            <select name="proof_required" defaultValue="none" className={inputCls}><option value="none">{t('missionsNew.none')}</option><option value="photo">{t('missionsNew.photo')}</option><option value="video">{t('missionsNew.video')}</option><option value="before_after">{t('missionsNew.beforeAmpAfter')}</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.safetyLevel')}</span>
            <select name="safety_level" defaultValue="none" className={inputCls}><option value="none">{t('missionsNew.none')}</option><option value="caution">{t('missionsNew.caution')}</option><option value="parent_required">{t('missionsNew.parentRequired')}</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.recurrence')}</span>
            <select name="recurrence" defaultValue="none" className={inputCls}><option value="none">One-time</option><option value="daily">{t('missionsNew.daily')}</option><option value="weekly">{t('missionsNew.weekly')}</option><option value="monthly">{t('missionsNew.monthly')}</option></select>
          </label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.autoApproveAtScoreBlankAlways')}</span><input type="number" name="auto_approve_score" min="0" max="100" className={inputCls} placeholder={t('missionsNew.eG85')} /></label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.dueDate')}</span><input type="datetime-local" name="due_at" className={inputCls} /></label>
          <label className={labelCls}><span className={spanCls}>{t('missionsNew.iconEmoji')}</span><input name="icon" maxLength={4} className={inputCls} placeholder="🧹" /></label>

          <div className="sm:col-span-2"><button className="inline-flex h-10 items-center gap-1 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Sparkles className="h-4 w-4" /> {t('missionsNew.createMission')}</button></div>
        </form>
      </Card>
    </div>
  );
}
