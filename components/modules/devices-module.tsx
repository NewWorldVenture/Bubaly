'use client';

import { useMemo, useState } from 'react';
import { Cpu, Plus, Trash2, Wifi, WifiOff, HelpCircle, Pencil } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { DEVICE_TYPES, DEVICE_INTEGRATIONS, DEVICE_STATUSES, integrationLabel, summarizeDevices, groupByRoom, type DeviceLike } from '@/lib/home/devices';
import type { Tables } from '@/lib/database.types';

type Device = Tables<'smart_devices'>;
const blank = () => ({ id: '', name: '', type: 'light', room: '', brand: '', integration: 'manual', status: 'unknown', last_state: '', note: '' });

const STATUS_ICON = { online: Wifi, offline: WifiOff, unknown: HelpCircle } as const;

export function DevicesModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: devices, loading, error, refresh } = useRealtimeQuery<Device>({
    table: 'smart_devices', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('smart_devices').select('*').eq('family_id', familyId).order('room').order('name'),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const all = useMemo(() => devices ?? [], [devices]);
  const stats = useMemo(() => summarizeDevices(all as DeviceLike[]), [all]);
  const groups = useMemo(() => groupByRoom((all) as (Device & DeviceLike)[]), [all]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.name.trim()) return;
    const row = { name: form.name.trim(), type: form.type, room: form.room.trim() || null, brand: form.brand.trim() || null, integration: form.integration, status: form.status, last_state: form.last_state.trim() || null, note: form.note.trim() || null };
    const supabase = createClient();
    const { error } = form.id
      ? await supabase.from('smart_devices').update(row).eq('id', form.id)
      : await supabase.from('smart_devices').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(describeDbError(error));
    success(form.id ? 'Updated' : 'Added'); setForm(null);
  }
  async function cycleStatus(d: Device) {
    const next = d.status === 'online' ? 'offline' : d.status === 'offline' ? 'unknown' : 'online';
    const { error } = await createClient().from('smart_devices').update({ status: next }).eq('id', d.id);
    if (error) toastError(describeDbError(error));
  }
  async function remove(id: string) {
    if (!confirm('Delete this device?')) return;
    const { error } = await createClient().from('smart_devices').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Deleted');
  }
  function edit(d: Device) {
    setForm({ id: d.id, name: d.name, type: d.type, room: d.room ?? '', brand: d.brand ?? '', integration: d.integration, status: d.status, last_state: d.last_state ?? '', note: d.note ?? '' });
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load family devices. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold"><Cpu className="h-4 w-4 text-brand-text" /> Smart Home</h3>
          <p className="text-xs text-muted">Unified registry of every connected device across HomeKit, Google, Alexa, SmartThings &amp; Matter.</p>
        </div>
        <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add device</Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Devices</p><p className="text-xl font-bold">{stats.total}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Online</p><p className="text-xl font-bold text-success">{stats.online}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Offline</p><p className="text-xl font-bold text-danger">{stats.offline}</p></div>
      </div>

      {all.length === 0 ? (
        <EmptyState icon={Cpu} title="No devices yet" description="Add your smart lights, locks, cameras and sensors to see them all in one place." />
      ) : groups.map((g) => (
        <div key={g.room}>
          <h4 className="mb-2 text-sm font-semibold">{g.room}</h4>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {g.devices.map((d) => {
              const Icon = STATUS_ICON[d.status as keyof typeof STATUS_ICON] ?? HelpCircle;
              return (
                <div key={d.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
                  <button onClick={() => cycleStatus(d)} title="Cycle status" className={d.status === 'online' ? 'text-success' : d.status === 'offline' ? 'text-danger' : 'text-muted'}><Icon className="h-4 w-4" /></button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.name}</p>
                    <p className="text-xs text-muted">{d.type}{d.brand ? ` · ${d.brand}` : ''} · {integrationLabel(d.integration)}{d.last_state ? ` · ${d.last_state}` : ''}</p>
                  </div>
                  <button onClick={() => edit(d)} className="text-muted hover:text-fg" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => remove(d.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit device' : 'Add device'}>
          <form onSubmit={save} className="space-y-3">
            <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Living room lamp" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">{(id) => <Select id={id} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>}</Field>
              <Field label="Room">{(id) => <Input id={id} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Brand">{(id) => <Input id={id} value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />}</Field>
              <Field label="Integration">{(id) => <Select id={id} value={form.integration} onChange={(e) => setForm({ ...form, integration: e.target.value })}>{DEVICE_INTEGRATIONS.map((i) => <option key={i} value={i}>{integrationLabel(i)}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">{(id) => <Select id={id} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{DEVICE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>}</Field>
              <Field label="Last state">{(id) => <Input id={id} value={form.last_state} onChange={(e) => setForm({ ...form, last_state: e.target.value })} placeholder="On, 72°F, Locked…" />}</Field>
            </div>
            <Field label="Note">{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
