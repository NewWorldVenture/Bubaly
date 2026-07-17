import type { Metadata } from 'next';
import { Phone, ShieldAlert, MapPin, UserCheck, HeartPulse, FileText } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty } from '@/components/family/shell';
import { QuickAdd } from '@/components/family/quick-add';
import { DeleteButton } from '@/components/family/record-actions';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Family Emergency' };
export const dynamic = 'force-dynamic';

export default async function FamilyEmergencyPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  // Emergency + medical data is gated to managers.
  const manager = isManager(ctx.active.role);

  const [membersRes, contactsRes, plansRes, profilesRes] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_emergency_contacts').select('*').eq('family_id', familyId).order('priority'),
    supabase.from('family_emergency_plans').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    manager ? supabase.from('medical_profiles').select('member_id, blood_type, allergies, conditions, emergency_contact_name, emergency_contact_phone').eq('family_id', familyId) : Promise.resolve({ data: [], error: null }),
  ]);

  // This is the crisis surface ("everything a caregiver needs in a crisis"). A
  // dropped error would render "No emergency contacts on file", "No emergency
  // plans yet", or "No medical profiles recorded" (hiding blood type, allergies,
  // and the ICE contact from a first responder) — a reassuring-but-wrong empty
  // state at exactly the worst moment. Fail closed on a real read error; a
  // genuinely missing table (unapplied migration) is still tolerated as empty.
  const emergencyError = [membersRes.error, contactsRes.error, plansRes.error, profilesRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (emergencyError) {
    console.error('[dashboard/family-emergency] emergency read failed', emergencyError);
    return <ErrorState message="Could not load your family emergency hub from Supabase. Refresh and try again." />;
  }

  const members = membersRes.data;
  const contacts = contactsRes.data;
  const plans = plansRes.data;
  const profiles = profilesRes.data;

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family Emergency Hub"
        description="Everything a caregiver needs in a crisis — contacts, plans and medical summaries."
        action={manager ? (
          <QuickAdd
            table="family_emergency_contacts"
            title="Add contact"
            members={members ?? []}
            fields={[
              { name: 'name', label: 'Name', type: 'text', required: true },
              { name: 'relationship', label: 'Relationship', type: 'text', placeholder: 'Grandparent, neighbor…' },
              { name: 'phone', label: 'Phone', type: 'text', required: true },
              { name: 'alt_phone', label: 'Alt phone', type: 'text' },
              { name: 'member_id', label: 'For member', type: 'member' },
              { name: 'can_pickup', label: 'Allowed to pick up kids', type: 'checkbox' },
            ]}
          />
        ) : undefined}
      />

      <SectionCard title="Emergency Contacts" description="Ordered by priority">
        {contacts && contacts.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-rose-500/15"><Phone className="h-5 w-5 text-rose-300" /></div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-semibold">{c.name}{c.is_primary && <span className="rounded bg-rose-500/20 px-1.5 text-[10px] font-bold text-rose-300">PRIMARY</span>}</p>
                  <p className="text-xs text-muted">{[c.relationship, c.member_id ? `for ${nameById.get(c.member_id)}` : null].filter(Boolean).join(' · ')}</p>
                  <a href={`tel:${c.phone}`} className="mt-1 inline-block text-sm font-semibold text-brand-text">{c.phone}</a>
                  {c.can_pickup && <p className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-300"><UserCheck className="h-3 w-3" /> Pickup approved</p>}
                </div>
                {manager && <DeleteButton table="family_emergency_contacts" id={c.id} />}
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={Phone} text={manager ? 'No emergency contacts yet — add one above.' : 'No emergency contacts on file.'} />}
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard
          title="Emergency Plans"
          action={manager ? (
            <QuickAdd
              table="family_emergency_plans" title="Add plan"
              fields={[
                { name: 'title', label: 'Title', type: 'text', required: true, placeholder: 'Fire / evacuation' },
                { name: 'plan_type', label: 'Type', type: 'text', placeholder: 'fire, medical, weather' },
                { name: 'safe_location', label: 'Safe meeting spot', type: 'text' },
                { name: 'instructions', label: 'Instructions', type: 'textarea' },
              ]}
            />
          ) : undefined}
        >
          {plans && plans.length > 0 ? (
            <ul className="space-y-2.5">
              {plans.map((p) => (
                <li key={p.id} className="rounded-xl bg-surface/40 p-3">
                  <p className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="h-4 w-4 text-orange-300" /> {p.title}</p>
                  {p.safe_location && <p className="mt-1 flex items-center gap-1 text-xs text-muted"><MapPin className="h-3 w-3" /> {p.safe_location}</p>}
                  {p.instructions && <p className="mt-1 text-xs text-fg/80">{p.instructions}</p>}
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={FileText} text="No emergency plans yet." />}
        </SectionCard>

        {manager && (
          <SectionCard title="Medical Summary" description="One-tap card for first responders">
            {profiles && profiles.length > 0 ? (
              <ul className="space-y-2.5">
                {profiles.map((p) => (
                  <li key={p.member_id} className="rounded-xl bg-surface/40 p-3">
                    <p className="flex items-center gap-2 text-sm font-semibold"><HeartPulse className="h-4 w-4 text-rose-400" /> {nameById.get(p.member_id) ?? 'Member'}</p>
                    <div className="mt-1 grid grid-cols-2 gap-1 text-xs text-muted">
                      {p.blood_type && <span>Blood: {p.blood_type}</span>}
                      {p.emergency_contact_phone && <span>ICE: {p.emergency_contact_phone}</span>}
                      {p.allergies && <span className="col-span-2 text-orange-300">Allergies: {p.allergies}</span>}
                      {p.conditions && <span className="col-span-2">Conditions: {p.conditions}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <MiniEmpty icon={HeartPulse} text="No medical profiles recorded." />}
          </SectionCard>
        )}
      </div>
    </div>
  );
}
