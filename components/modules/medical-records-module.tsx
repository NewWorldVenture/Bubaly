'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Stethoscope, Smile, Plus, Pencil, Trash2, FileText, ClipboardList,
  Phone, ShieldCheck, Camera, ChevronRight, Lock, Sparkles, X,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { uploadFamilyDocument, getDocumentSignedUrl } from '@/lib/storage/documents';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { LoadingBlock, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { ProviderInfoSheet, CheckInSheet } from '@/components/medical/print-sheet';
import { cn } from '@/lib/utils/cn';
import type { Tables, RecordKind } from '@/lib/database.types';
import type { MedicalRecordsInsights, MedicalRecordsAIResponse } from '@/lib/medical-records/medical-records-ai';

type Provider = Tables<'health_providers'>;
type Policy = Tables<'insurance_policies'>;
type Profile = Tables<'medical_profiles'>;

const COPY: Record<RecordKind, { title: string; desc: string; provider: string; Icon: typeof Stethoscope }> = {
  medical: { title: 'Medical', desc: 'Doctors, insurance, and health records for the whole family.', provider: 'Doctor', Icon: Stethoscope },
  dental: { title: 'Dental', desc: 'Dentists, dental insurance, and oral-health records for the family.', provider: 'Dentist', Icon: Smile },
};

const WHOLE_FAMILY = '__family__';

const blankProvider = { id: '', member_id: '', name: '', specialty: '', practice_name: '', phone: '', fax: '', email: '', address: '', is_primary: false, notes: '' };
const blankPolicy = { id: '', member_id: '', insurer: '', plan_name: '', plan_type: '', policy_number: '', group_number: '', rx_bin: '', rx_pcn: '', rx_group: '', customer_service_phone: '', effective_date: '', is_primary: true, notes: '', front_image_path: '', back_image_path: '' };
const blankProfile = { member_id: '', blood_type: '', allergies: '', conditions: '', current_medications: '', primary_physician: '', preferred_pharmacy: '', pharmacy_phone: '', emergency_contact_name: '', emergency_contact_phone: '', emergency_contact_relation: '', immunizations: '', dental_notes: '', notes: '' };

/** Renders a private Storage image via a short-lived signed URL. */
function CardImage({ path, label }: { path: string | null; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!path) { setUrl(null); return; }
    const sb = createClient();
    getDocumentSignedUrl(sb, path, 600).then(({ url }) => { if (active) setUrl(url); });
    return () => { active = false; };
  }, [path]);
  if (!path) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt={label} className="h-24 w-full object-cover" /> : <div className="grid h-24 w-full place-items-center bg-surface/40 text-xs text-muted">{label}</div>}
    </div>
  );
}

export function MedicalRecordsModule({ kind }: { kind: RecordKind }) {
  const { familyId, userId, members, selfMember, role } = useApp();
  const { success, error: toastError } = useToast();
  const canEdit = isManager(role);
  const { title, desc, provider: providerWord, Icon } = COPY[kind];

  // ── Data ──────────────────────────────────────────────────
  const { data: providers, loading: pLoading, error: pError } = useRealtimeQuery<Provider>({
    table: 'health_providers', familyId, deps: [familyId, kind],
    fetcher: (sb) => sb.from('health_providers').select('*').eq('family_id', familyId).eq('kind', kind).order('is_primary', { ascending: false }).order('name'),
  });
  const { data: policies, loading: polLoading, error: polError } = useRealtimeQuery<Policy>({
    table: 'insurance_policies', familyId, deps: [familyId, kind],
    fetcher: (sb) => sb.from('insurance_policies').select('*').eq('family_id', familyId).eq('kind', kind).order('is_primary', { ascending: false }),
  });
  const { data: profiles, loading: profLoading, error: profError } = useRealtimeQuery<Profile>({
    table: 'medical_profiles', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('medical_profiles').select('*').eq('family_id', familyId),
  });
  const { data: medications } = useRealtimeQuery<Tables<'medications'>>({
    table: 'medications', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('medications').select('*').eq('family_id', familyId).eq('is_active', true),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const profileByMember = useMemo(() => new Map(profiles.map((p) => [p.member_id, p])), [profiles]);
  const loading = pLoading || polLoading || profLoading;
  const error = pError || polError || profError;

  // Providers grouped: whole-family first, then per member.
  const providerGroups = useMemo(() => {
    const groups: { key: string; label: string; color: string | null; member: Tables<'family_members'> | null; items: Provider[] }[] = [];
    const family = providers.filter((p) => !p.member_id);
    if (family.length) groups.push({ key: WHOLE_FAMILY, label: 'Whole Family', color: null, member: null, items: family });
    for (const m of members) {
      const items = providers.filter((p) => p.member_id === m.id);
      if (items.length) groups.push({ key: m.id, label: m.display_name, color: m.color, member: m, items });
    }
    return groups;
  }, [providers, members]);

  // ── Modal state ───────────────────────────────────────────
  const [providerForm, setProviderForm] = useState<typeof blankProvider | null>(null);
  const [policyForm, setPolicyForm] = useState<typeof blankPolicy | null>(null);
  const [profileForm, setProfileForm] = useState<typeof blankProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'front' | 'back' | null>(null);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<MedicalRecordsInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<MedicalRecordsAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/medical-records', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'AI analysis failed');
      setAiAnalysis(json.analysis ?? null);
      setAiInsights(json.aiInsights ?? null);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'AI analysis failed');
    } finally {
      setAiLoading(false);
    }
  }

  // Print sheets
  const [infoSheet, setInfoSheet] = useState<{ member: Tables<'family_members'> | null; items: Provider[] } | null>(null);
  const [checkInPicker, setCheckInPicker] = useState(false);
  const [checkInMemberId, setCheckInMemberId] = useState<string | null>(null);

  const checkInMember = checkInMemberId ? memberById.get(checkInMemberId) ?? null : null;

  // ── CRUD ──────────────────────────────────────────────────
  async function saveProvider() {
    if (!providerForm?.name) return;
    setSaving(true);
    const sb = createClient();
    const fields = {
      member_id: providerForm.member_id || null,
      name: providerForm.name,
      specialty: providerForm.specialty || null,
      practice_name: providerForm.practice_name || null,
      phone: providerForm.phone || null,
      fax: providerForm.fax || null,
      email: providerForm.email || null,
      address: providerForm.address || null,
      is_primary: providerForm.is_primary,
      notes: providerForm.notes || null,
    };
    const { error: err } = providerForm.id
      ? await sb.from('health_providers').update(fields).eq('id', providerForm.id)
      : await sb.from('health_providers').insert({ ...fields, family_id: familyId, kind, created_by: userId });
    setSaving(false);
    if (err) { toastError(`Could not save ${providerWord.toLowerCase()}`); return; }
    success(`${providerWord} saved`);
    setProviderForm(null);
  }

  async function deleteProvider(id: string) {
    const sb = createClient();
    const { error: err } = await sb.from('health_providers').delete().eq('id', id);
    if (err) { toastError('Could not delete'); return; }
    success('Deleted');
  }

  async function uploadCard(side: 'front' | 'back', file: File) {
    if (!policyForm) return;
    setUploading(side);
    const sb = createClient();
    const { path, error: err } = await uploadFamilyDocument(sb, { familyId, folder: 'insurance', file });
    setUploading(null);
    if (err || !path) { toastError(err ?? 'Upload failed'); return; }
    setPolicyForm((f) => (f ? { ...f, [side === 'front' ? 'front_image_path' : 'back_image_path']: path } : f));
    success(`${side === 'front' ? 'Front' : 'Back'} of card uploaded`);
  }

  async function savePolicy() {
    if (!policyForm?.insurer) return;
    setSaving(true);
    const sb = createClient();
    const fields = {
      member_id: policyForm.member_id || null,
      insurer: policyForm.insurer,
      plan_name: policyForm.plan_name || null,
      plan_type: policyForm.plan_type || null,
      policy_number: policyForm.policy_number || null,
      group_number: policyForm.group_number || null,
      rx_bin: policyForm.rx_bin || null,
      rx_pcn: policyForm.rx_pcn || null,
      rx_group: policyForm.rx_group || null,
      customer_service_phone: policyForm.customer_service_phone || null,
      effective_date: policyForm.effective_date || null,
      is_primary: policyForm.is_primary,
      front_image_path: policyForm.front_image_path || null,
      back_image_path: policyForm.back_image_path || null,
      notes: policyForm.notes || null,
    };
    const { error: err } = policyForm.id
      ? await sb.from('insurance_policies').update(fields).eq('id', policyForm.id)
      : await sb.from('insurance_policies').insert({ ...fields, family_id: familyId, kind, created_by: userId });
    setSaving(false);
    if (err) { toastError('Could not save insurance'); return; }
    success('Insurance saved');
    setPolicyForm(null);
  }

  async function deletePolicy(id: string) {
    const sb = createClient();
    const { error: err } = await sb.from('insurance_policies').delete().eq('id', id);
    if (err) { toastError('Could not delete'); return; }
    success('Deleted');
  }

  async function saveProfile() {
    if (!profileForm?.member_id) return;
    setSaving(true);
    const sb = createClient();
    const payload = {
      family_id: familyId,
      member_id: profileForm.member_id,
      blood_type: profileForm.blood_type || null,
      allergies: profileForm.allergies || null,
      conditions: profileForm.conditions || null,
      current_medications: profileForm.current_medications || null,
      primary_physician: profileForm.primary_physician || null,
      preferred_pharmacy: profileForm.preferred_pharmacy || null,
      pharmacy_phone: profileForm.pharmacy_phone || null,
      emergency_contact_name: profileForm.emergency_contact_name || null,
      emergency_contact_phone: profileForm.emergency_contact_phone || null,
      emergency_contact_relation: profileForm.emergency_contact_relation || null,
      immunizations: profileForm.immunizations || null,
      dental_notes: profileForm.dental_notes || null,
      notes: profileForm.notes || null,
      updated_by: userId,
    };
    const { error: err } = await sb.from('medical_profiles').upsert(payload, { onConflict: 'member_id' });
    setSaving(false);
    if (err) { toastError('Could not save profile'); return; }
    success('Profile saved');
    setProfileForm(null);
  }

  function openProfile(memberId: string) {
    const existing = profileByMember.get(memberId);
    setProfileForm(existing
      ? {
          member_id: memberId,
          blood_type: existing.blood_type ?? '', allergies: existing.allergies ?? '', conditions: existing.conditions ?? '',
          current_medications: existing.current_medications ?? '', primary_physician: existing.primary_physician ?? '',
          preferred_pharmacy: existing.preferred_pharmacy ?? '', pharmacy_phone: existing.pharmacy_phone ?? '',
          emergency_contact_name: existing.emergency_contact_name ?? '', emergency_contact_phone: existing.emergency_contact_phone ?? '',
          emergency_contact_relation: existing.emergency_contact_relation ?? '', immunizations: existing.immunizations ?? '',
          dental_notes: existing.dental_notes ?? '', notes: existing.notes ?? '',
        }
      : { ...blankProfile, member_id: memberId });
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description={desc}
        action={
          canEdit ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={runAiAssist} loading={aiLoading}>
                <Sparkles className="h-4 w-4 text-brand" /> AI Assist
              </Button>
              <Button onClick={() => setCheckInPicker(true)} className="btn-cta"><ClipboardList className="h-4 w-4" /> At the Doctor</Button>
              <Button onClick={() => setProviderForm({ ...blankProvider })} className="btn-secondary"><Plus className="h-4 w-4" /> Add {providerWord}</Button>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted"><Lock className="h-3.5 w-3.5" /> View only</span>
          )
        }
      />

      {(aiAnalysis || aiInsights) && (
        <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-brand" /> AI Medical Records Insights
            </p>
            <button onClick={() => { setAiAnalysis(null); setAiInsights(null); }}><X className="h-4 w-4 text-muted" /></button>
          </div>
          {aiAnalysis && <p className="mb-3 text-sm text-muted">{aiAnalysis.summary}</p>}
          {aiInsights && (
            <div className="space-y-2">
              {aiInsights.suggestions.map((s, i) => (
                <p key={i} className="text-sm">• {s}</p>
              ))}
              {aiInsights.organizationTips.length > 0 && (
                <div className="mt-2 pt-2 border-t border-brand/20">
                  <p className="text-xs font-semibold text-brand mb-1">Organization Tips</p>
                  {aiInsights.organizationTips.map((t, i) => <p key={i} className="text-xs text-muted">• {t}</p>)}
                </div>
              )}
              {aiInsights.preparationTip && <p className="mt-2 text-xs text-muted italic">{aiInsights.preparationTip}</p>}
            </div>
          )}
        </div>
      )}

      {/* ── Insurance ─────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-brand" /> Insurance Cards</h2>
          {canEdit && <button onClick={() => setPolicyForm({ ...blankPolicy })} className="text-xs font-semibold text-brand">+ Add insurance</button>}
        </div>
        {policies.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No insurance on file" description={canEdit ? `Add a ${title.toLowerCase()} insurance plan and snap a photo of the card.` : 'No insurance has been added yet.'} action={canEdit ? <Button onClick={() => setPolicyForm({ ...blankPolicy })} className="btn-cta"><Plus className="h-4 w-4" /> Add Insurance</Button> : undefined} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {policies.map((p) => {
              const m = p.member_id ? memberById.get(p.member_id) : null;
              return (
                <div key={p.id} className="rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-bold">{p.insurer}</p>
                      <p className="text-xs text-muted">{[p.plan_name, p.plan_type].filter(Boolean).join(' · ') || 'Plan'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {p.is_primary && <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">PRIMARY</span>}
                      {canEdit && (
                        <>
                          <button onClick={() => setPolicyForm({ id: p.id, member_id: p.member_id ?? '', insurer: p.insurer, plan_name: p.plan_name ?? '', plan_type: p.plan_type ?? '', policy_number: p.policy_number ?? '', group_number: p.group_number ?? '', rx_bin: p.rx_bin ?? '', rx_pcn: p.rx_pcn ?? '', rx_group: p.rx_group ?? '', customer_service_phone: p.customer_service_phone ?? '', effective_date: p.effective_date ?? '', is_primary: p.is_primary, notes: p.notes ?? '', front_image_path: p.front_image_path ?? '', back_image_path: p.back_image_path ?? '' })} className="text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => deletePolicy(p.id)} className="text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                    {p.policy_number && <div><dt className="text-muted">Member ID</dt><dd className="font-semibold">{p.policy_number}</dd></div>}
                    {p.group_number && <div><dt className="text-muted">Group</dt><dd className="font-semibold">{p.group_number}</dd></div>}
                    {m && <div><dt className="text-muted">Covers</dt><dd className="font-semibold">{m.display_name}</dd></div>}
                    {p.customer_service_phone && <div><dt className="text-muted">Phone</dt><dd className="font-semibold">{p.customer_service_phone}</dd></div>}
                  </dl>
                  {(p.front_image_path || p.back_image_path) && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <CardImage path={p.front_image_path} label="Front" />
                      <CardImage path={p.back_image_path} label="Back" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Providers ─────────────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><Icon className="h-4 w-4 text-brand" /> {providerWord}s</h2>
          {canEdit && <button onClick={() => setProviderForm({ ...blankProvider })} className="text-xs font-semibold text-brand">+ Add {providerWord.toLowerCase()}</button>}
        </div>
        {providerGroups.length === 0 ? (
          <EmptyState icon={Icon} title={`No ${providerWord.toLowerCase()}s yet`} description={canEdit ? `Add your family's ${providerWord.toLowerCase()}s and generate a printable info file.` : 'No providers have been added yet.'} action={canEdit ? <Button onClick={() => setProviderForm({ ...blankProvider })} className="btn-cta"><Plus className="h-4 w-4" /> Add {providerWord}</Button> : undefined} />
        ) : (
          <div className="space-y-4">
            {providerGroups.map((g) => (
              <div key={g.key} className="rounded-xl border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {g.member ? <Avatar name={g.label} color={g.color} size={28} /> : <div className="grid h-7 w-7 place-items-center rounded-full bg-brand/15 text-brand"><Stethoscope className="h-4 w-4" /></div>}
                    <span className="text-sm font-semibold">{g.label}</span>
                  </div>
                  <button onClick={() => setInfoSheet({ member: g.member, items: g.items })} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-muted hover:text-fg">
                    <FileText className="h-3.5 w-3.5" /> Info File
                  </button>
                </div>
                <div className="space-y-2">
                  {g.items.map((p) => (
                    <div key={p.id} className="flex items-center gap-3 rounded-lg bg-surface/40 p-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{p.name}{p.is_primary && <span className="ml-2 text-[10px] font-bold text-emerald-300">PRIMARY</span>}</p>
                        <p className="truncate text-xs text-muted">{[p.specialty, p.practice_name].filter(Boolean).join(' · ') || providerWord}</p>
                      </div>
                      {p.phone && <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 text-xs text-brand"><Phone className="h-3 w-3" />{p.phone}</a>}
                      {canEdit && (
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => setProviderForm({ id: p.id, member_id: p.member_id ?? '', name: p.name, specialty: p.specialty ?? '', practice_name: p.practice_name ?? '', phone: p.phone ?? '', fax: p.fax ?? '', email: p.email ?? '', address: p.address ?? '', is_primary: p.is_primary, notes: p.notes ?? '' })} className="text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => deleteProvider(p.id)} className="text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Medical Profiles ──────────────────────────────── */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold"><ClipboardList className="h-4 w-4 text-brand" /> Health Profiles</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {members.map((m) => {
            const prof = profileByMember.get(m.id);
            return (
              <div key={m.id} className="rounded-xl border border-border p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={m.display_name} color={m.color} size={32} />
                    <div>
                      <p className="text-sm font-semibold">{m.display_name}</p>
                      <p className="text-xs text-muted">{m.role}</p>
                    </div>
                  </div>
                  {canEdit && <button onClick={() => openProfile(m.id)} className="text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>}
                </div>
                {prof ? (
                  <dl className="space-y-1 text-xs">
                    {prof.blood_type && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted">Blood Type</dt><dd className="font-medium">{prof.blood_type}</dd></div>}
                    <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted">Allergies</dt><dd className="font-medium">{prof.allergies || 'None reported'}</dd></div>
                    <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted">Conditions</dt><dd className="font-medium">{prof.conditions || 'None reported'}</dd></div>
                    {kind === 'dental' && prof.dental_notes && <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted">Dental</dt><dd className="font-medium">{prof.dental_notes}</dd></div>}
                  </dl>
                ) : (
                  <p className="text-xs text-muted">{canEdit ? 'No profile yet — click the pencil to add allergies, conditions, and emergency contacts.' : 'No profile on file.'}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Provider modal ────────────────────────────────── */}
      <Modal open={!!providerForm} title={providerForm?.id ? `Edit ${providerWord}` : `Add ${providerWord}`} onClose={() => setProviderForm(null)}>
        {providerForm && (
          <div className="space-y-3">
            <Field label="Belongs to">{(id) => <Select id={id} value={providerForm.member_id} onChange={(e) => setProviderForm({ ...providerForm, member_id: e.target.value })}><option value="">Whole Family</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
            <Field label="Name">{(id) => <Input id={id} value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} placeholder={kind === 'dental' ? 'e.g. Dr. Mark Williams' : 'e.g. Dr. Sarah Patel'} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Specialty">{(id) => <Input id={id} value={providerForm.specialty} onChange={(e) => setProviderForm({ ...providerForm, specialty: e.target.value })} placeholder={kind === 'dental' ? 'Orthodontist' : 'Pediatrician'} />}</Field>
              <Field label="Practice">{(id) => <Input id={id} value={providerForm.practice_name} onChange={(e) => setProviderForm({ ...providerForm, practice_name: e.target.value })} placeholder="Clinic name" />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone">{(id) => <Input id={id} value={providerForm.phone} onChange={(e) => setProviderForm({ ...providerForm, phone: e.target.value })} placeholder="(555) 123-4567" />}</Field>
              <Field label="Fax">{(id) => <Input id={id} value={providerForm.fax} onChange={(e) => setProviderForm({ ...providerForm, fax: e.target.value })} placeholder="(555) 123-4568" />}</Field>
            </div>
            <Field label="Email">{(id) => <Input id={id} value={providerForm.email} onChange={(e) => setProviderForm({ ...providerForm, email: e.target.value })} placeholder="office@clinic.com" />}</Field>
            <Field label="Address">{(id) => <Input id={id} value={providerForm.address} onChange={(e) => setProviderForm({ ...providerForm, address: e.target.value })} placeholder="123 Main St, Suite 200" />}</Field>
            <Field label="Notes">{(id) => <Textarea id={id} value={providerForm.notes} onChange={(e) => setProviderForm({ ...providerForm, notes: e.target.value })} rows={2} placeholder="Hours, parking, portal login, etc." />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={providerForm.is_primary} onChange={(e) => setProviderForm({ ...providerForm, is_primary: e.target.checked })} /> Primary {providerWord.toLowerCase()}</label>
            <Button onClick={saveProvider} disabled={saving || !providerForm.name} loading={saving} className="w-full">{providerForm.id ? 'Save Changes' : `Add ${providerWord}`}</Button>
          </div>
        )}
      </Modal>

      {/* ── Insurance modal ───────────────────────────────── */}
      <Modal open={!!policyForm} title={policyForm?.id ? 'Edit Insurance' : 'Add Insurance'} onClose={() => setPolicyForm(null)} className="sm:max-w-lg">
        {policyForm && (
          <div className="space-y-3">
            <Field label="Covers">{(id) => <Select id={id} value={policyForm.member_id} onChange={(e) => setPolicyForm({ ...policyForm, member_id: e.target.value })}><option value="">Whole Family</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Insurer">{(id) => <Input id={id} value={policyForm.insurer} onChange={(e) => setPolicyForm({ ...policyForm, insurer: e.target.value })} placeholder={kind === 'dental' ? 'Delta Dental' : 'Blue Cross Blue Shield'} />}</Field>
              <Field label="Plan Name">{(id) => <Input id={id} value={policyForm.plan_name} onChange={(e) => setPolicyForm({ ...policyForm, plan_name: e.target.value })} placeholder="PPO Family" />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Member / Policy #">{(id) => <Input id={id} value={policyForm.policy_number} onChange={(e) => setPolicyForm({ ...policyForm, policy_number: e.target.value })} placeholder="XYZ123456789" />}</Field>
              <Field label="Group #">{(id) => <Input id={id} value={policyForm.group_number} onChange={(e) => setPolicyForm({ ...policyForm, group_number: e.target.value })} placeholder="GRP-0042" />}</Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Rx BIN">{(id) => <Input id={id} value={policyForm.rx_bin} onChange={(e) => setPolicyForm({ ...policyForm, rx_bin: e.target.value })} />}</Field>
              <Field label="Rx PCN">{(id) => <Input id={id} value={policyForm.rx_pcn} onChange={(e) => setPolicyForm({ ...policyForm, rx_pcn: e.target.value })} />}</Field>
              <Field label="Rx Group">{(id) => <Input id={id} value={policyForm.rx_group} onChange={(e) => setPolicyForm({ ...policyForm, rx_group: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Member Services Phone">{(id) => <Input id={id} value={policyForm.customer_service_phone} onChange={(e) => setPolicyForm({ ...policyForm, customer_service_phone: e.target.value })} placeholder="(800) 555-1000" />}</Field>
              <Field label="Effective Date">{(id) => <Input id={id} type="date" value={policyForm.effective_date} onChange={(e) => setPolicyForm({ ...policyForm, effective_date: e.target.value })} />}</Field>
            </div>
            {/* Card photos */}
            <div className="grid grid-cols-2 gap-3">
              {(['front', 'back'] as const).map((side) => (
                <div key={side}>
                  <p className="mb-1.5 text-xs font-medium text-muted capitalize">{side} of card</p>
                  <CardImage path={side === 'front' ? policyForm.front_image_path : policyForm.back_image_path} label={`${side} of card`} />
                  <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2 text-xs font-semibold text-muted hover:text-fg">
                    <Camera className="h-4 w-4" /> {uploading === side ? 'Uploading…' : 'Take photo / Upload'}
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCard(side, f); e.target.value = ''; }} />
                  </label>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policyForm.is_primary} onChange={(e) => setPolicyForm({ ...policyForm, is_primary: e.target.checked })} /> Primary plan</label>
            <Button onClick={savePolicy} disabled={saving || !policyForm.insurer} loading={saving} className="w-full">{policyForm.id ? 'Save Changes' : 'Add Insurance'}</Button>
          </div>
        )}
      </Modal>

      {/* ── Profile modal ─────────────────────────────────── */}
      <Modal open={!!profileForm} title="Health Profile" description={profileForm ? memberById.get(profileForm.member_id)?.display_name : undefined} onClose={() => setProfileForm(null)} className="sm:max-w-lg">
        {profileForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Blood Type">{(id) => <Input id={id} value={profileForm.blood_type} onChange={(e) => setProfileForm({ ...profileForm, blood_type: e.target.value })} placeholder="O+" />}</Field>
              <Field label="Primary Physician">{(id) => <Input id={id} value={profileForm.primary_physician} onChange={(e) => setProfileForm({ ...profileForm, primary_physician: e.target.value })} placeholder="Dr. Patel" />}</Field>
            </div>
            <Field label="Allergies">{(id) => <Textarea id={id} value={profileForm.allergies} onChange={(e) => setProfileForm({ ...profileForm, allergies: e.target.value })} rows={2} placeholder="Penicillin, peanuts…" />}</Field>
            <Field label="Conditions">{(id) => <Textarea id={id} value={profileForm.conditions} onChange={(e) => setProfileForm({ ...profileForm, conditions: e.target.value })} rows={2} placeholder="Asthma, ADHD…" />}</Field>
            <Field label="Current Medications">{(id) => <Textarea id={id} value={profileForm.current_medications} onChange={(e) => setProfileForm({ ...profileForm, current_medications: e.target.value })} rows={2} placeholder="Albuterol inhaler as needed…" />}</Field>
            <Field label="Immunizations">{(id) => <Input id={id} value={profileForm.immunizations} onChange={(e) => setProfileForm({ ...profileForm, immunizations: e.target.value })} placeholder="Up to date · Flu 2025" />}</Field>
            {kind === 'dental' && <Field label="Dental Notes">{(id) => <Textarea id={id} value={profileForm.dental_notes} onChange={(e) => setProfileForm({ ...profileForm, dental_notes: e.target.value })} rows={2} placeholder="Braces, sensitivity, last cleaning…" />}</Field>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Preferred Pharmacy">{(id) => <Input id={id} value={profileForm.preferred_pharmacy} onChange={(e) => setProfileForm({ ...profileForm, preferred_pharmacy: e.target.value })} placeholder="Walgreens, Oak St" />}</Field>
              <Field label="Pharmacy Phone">{(id) => <Input id={id} value={profileForm.pharmacy_phone} onChange={(e) => setProfileForm({ ...profileForm, pharmacy_phone: e.target.value })} placeholder="(555) 222-3333" />}</Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Emergency Contact">{(id) => <Input id={id} value={profileForm.emergency_contact_name} onChange={(e) => setProfileForm({ ...profileForm, emergency_contact_name: e.target.value })} placeholder="Name" />}</Field>
              <Field label="Relationship">{(id) => <Input id={id} value={profileForm.emergency_contact_relation} onChange={(e) => setProfileForm({ ...profileForm, emergency_contact_relation: e.target.value })} placeholder="Grandmother" />}</Field>
              <Field label="Their Phone">{(id) => <Input id={id} value={profileForm.emergency_contact_phone} onChange={(e) => setProfileForm({ ...profileForm, emergency_contact_phone: e.target.value })} placeholder="(555) 876-5432" />}</Field>
            </div>
            <Field label="Other Notes">{(id) => <Textarea id={id} value={profileForm.notes} onChange={(e) => setProfileForm({ ...profileForm, notes: e.target.value })} rows={2} />}</Field>
            <Button onClick={saveProfile} disabled={saving} loading={saving} className="w-full">Save Profile</Button>
          </div>
        )}
      </Modal>

      {/* ── Check-in member picker ────────────────────────── */}
      <Modal open={checkInPicker} title="At the Doctor — Check-In" description="Who is this visit for? We'll show everything you need for the intake form." onClose={() => setCheckInPicker(false)}>
        <div className="space-y-2">
          {selfMember && (
            <button onClick={() => { setCheckInMemberId(selfMember.id); setCheckInPicker(false); }} className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left hover:bg-elevated">
              <Avatar name={selfMember.display_name} color={selfMember.color} size={36} />
              <div className="flex-1"><p className="text-sm font-semibold">{selfMember.display_name} (Me)</p><p className="text-xs text-muted">Myself</p></div>
              <ChevronRight className="h-4 w-4 text-muted" />
            </button>
          )}
          {members.filter((m) => m.id !== selfMember?.id).map((m) => (
            <button key={m.id} onClick={() => { setCheckInMemberId(m.id); setCheckInPicker(false); }} className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left hover:bg-elevated">
              <Avatar name={m.display_name} color={m.color} size={36} />
              <div className="flex-1"><p className="text-sm font-semibold">{m.display_name}</p><p className="text-xs text-muted capitalize">{m.role}</p></div>
              <ChevronRight className="h-4 w-4 text-muted" />
            </button>
          ))}
        </div>
      </Modal>

      {/* ── Print sheets ──────────────────────────────────── */}
      {infoSheet && (
        <ProviderInfoSheet kind={kind} member={infoSheet.member} providers={infoSheet.items} onClose={() => setInfoSheet(null)} />
      )}
      {checkInMember && (
        <CheckInSheet
          kind={kind}
          member={checkInMember}
          profile={profileByMember.get(checkInMember.id) ?? null}
          policy={policies.find((p) => p.member_id === checkInMember.id) ?? policies.find((p) => !p.member_id) ?? null}
          providers={providers.filter((p) => p.member_id === checkInMember.id || !p.member_id)}
          medications={medications.filter((m) => m.member_id === checkInMember.id)}
          onClose={() => setCheckInMemberId(null)}
        />
      )}
    </div>
  );
}
