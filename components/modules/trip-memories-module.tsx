'use client';

import { useMemo, useState } from 'react';
import { BookHeart, Plus, Trash2, MapPin, Plane, ImageIcon } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import { groupByTrip } from '@/lib/vacations/memories';
import { uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_MB } from '@/lib/storage/documents';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Memory = Tables<'trip_memories'>;
type VacationLite = { id: string; title: string };

const blank = () => ({ title: '', memory_date: new Date().toISOString().slice(0, 10), note: '', location: '', vacation_id: '', member_id: '', file: null as File | null });

export function TripMemoriesModule() {
  const t = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: memories, loading: memoriesLoading, error: memoriesError, refresh: refreshMemories } = useRealtimeQuery<Memory>({
    table: 'trip_memories', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('trip_memories').select('*').eq('family_id', familyId).order('memory_date', { ascending: false }),
  });
  const { data: vacations, loading: vacationsLoading, error: vacationsError, refresh: refreshVacations } = useRealtimeQuery<VacationLite>({
    table: 'vacations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('vacations').select('id, title').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [saving, setSaving] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const all = useMemo(() => memories ?? [], [memories]);
  const groups = useMemo(() => groupByTrip(all), [all]);
  const vacName = (id: string) => (vacations ?? []).find((v) => v.id === id)?.title ?? 'Trip';
  const loading = memoriesLoading || vacationsLoading;
  const error = memoriesError || vacationsError;
  const refresh = () => { void refreshMemories(); void refreshVacations(); };

  // Lazily sign photo URLs once memories load.
  useMemo(() => {
    const need = all.filter((m) => m.photo_path && !urls[m.photo_path]);
    if (need.length === 0) return;
    (async () => {
      const sb = createClient();
      const next: Record<string, string> = {};
      for (const m of need) {
        if (!m.photo_path) continue;
        const { url } = await getDocumentSignedUrl(sb, m.photo_path, 3600);
        if (url) next[m.photo_path] = url;
      }
      if (Object.keys(next).length) setUrls((u) => ({ ...u, ...next }));
    })();
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.title.trim()) return;
    setSaving(true);
    const supabase = createClient();
    let photo_path: string | null = null;
    try {
      if (form.file) {
        const { path, error } = await uploadFamilyDocument(supabase, { familyId, folder: 'trip-memories', file: form.file });
        if (error) { setSaving(false); return toastError(error); }
        photo_path = path;
      }
      const { error } = await supabase.from('trip_memories').insert({
        family_id: familyId,
        vacation_id: form.vacation_id || null,
        title: form.title.trim(),
        memory_date: form.memory_date,
        note: form.note.trim() || null,
        location: form.location.trim() || null,
        photo_path,
        member_id: form.member_id || null,
        created_by: userId,
      });
      if (error) return toastError(describeDbError(error));
      success(t('tripMemoriesModule.memorySaved'));
      setForm(null);
    } finally {
      setSaving(false);
    }
  }

  async function remove(m: Memory) {
    if (!confirm(t('tripMemoriesModule.deleteThisMemory'))) return;
    const supabase = createClient();
    if (m.photo_path) await removeFamilyDocument(supabase, m.photo_path);
    const { error } = await supabase.from('trip_memories').delete().eq('id', m.id);
    if (error) toastError(describeDbError(error)); else success(t('tripMemoriesModule.deleted'));
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={t('tripMemoriesModule.couldNotLoadTripMemories')} onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><BookHeart className="h-4 w-4 text-brand-text" /> {t('tripMemories.tripMemories')}</h3>
        <div className="flex items-center gap-2">
          <AiInsight kind="memories" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> {t('tripMemories.addMemory')}</Button>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState icon={BookHeart} title={t('tripMemories.noMemoriesYet')} description={t('tripMemoriesModule.captureMomentsFromYourTrips')} />
      ) : groups.map((g) => (
        <div key={g.vacationId || 'general'}>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            {g.vacationId ? <><Plane className="h-3.5 w-3.5 text-brand-text" /> {vacName(g.vacationId)}</> : 'Other memories'}
            <span className="text-xs font-normal text-muted">· {g.memories.length}</span>
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.memories.map((m) => {
              const photo = m.photo_path ? urls[m.photo_path] : null;
              const mem = m.member_id ? memberById.get(m.member_id) : null;
              return (
                <div key={m.id} className="overflow-hidden rounded-2xl border border-border bg-surface/40">
                  <div className="flex aspect-video items-center justify-center bg-elevated">
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photo} alt={m.title} className="h-full w-full object-cover" />
                    ) : <ImageIcon className="h-8 w-8 text-muted" />}
                  </div>
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium">{m.title}</p>
                      <button onClick={() => remove(m)} className="text-muted hover:text-danger" aria-label={t('tripMemories.delete')}><Trash2 className="h-4 w-4" /></button>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {fmtDate(m.memory_date)}{m.location ? <> · <MapPin className="inline h-3 w-3" /> {m.location}</> : ''}{mem ? ` · ${mem.display_name}` : ''}
                    </p>
                    {m.note && <p className="mt-1 text-sm text-fg/90">{m.note}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {form && (
        <Modal open onClose={() => setForm(null)} title={t('tripMemories.addTripMemory')}>
          <form onSubmit={save} className="space-y-3">
            <Field label={t('tripMemories.title')}>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('tripMemories.sunsetAtTheBeach')} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('tripMemories.date')}>{(id) => <Input id={id} type="date" value={form.memory_date} onChange={(e) => setForm({ ...form, memory_date: e.target.value })} />}</Field>
              <Field label={t('tripMemories.location')}>{(id) => <Input id={id} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder={t('tripMemories.mauiHi')} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(vacations ?? []).length > 0 && (
                <Field label={t('tripMemories.trip')}>{(id) => <Select id={id} value={form.vacation_id} onChange={(e) => setForm({ ...form, vacation_id: e.target.value })}><option value="">{t('tripMemories.none')}</option>{(vacations ?? []).map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}</Select>}</Field>
              )}
              <Field label={t('tripMemories.member')}>{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}><option value="">{t('tripMemories.none')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
            </div>
            <Field label={t('tripMemories.note')}>{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('tripMemories.whatMadeThisSpecial')} />}</Field>
            <Field label={t('tripMemories.photoOptional')}>
              {(id) => <input id={id} type="file" accept="image/*" onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && f.size > DOCUMENT_MAX_BYTES) { toastError(`“${f.name}” is too large (max ${DOCUMENT_MAX_MB} MB).`); e.target.value = ''; return; }
                setForm({ ...form, file: f });
              }} className="block w-full text-sm text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-elevated file:px-3 file:py-1.5 file:text-sm" />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>{t('tripMemories.cancel')}</Button>
              <Button type="submit" loading={saving}>{t('tripMemories.saveMemory')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
