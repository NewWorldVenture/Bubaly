'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, X, HelpCircle, MapPin, Clock, CalendarDays, Pencil, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { deleteCalendarEventAction } from '@/app/(app)/dashboard/calendar/actions';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { AiInsight } from '@/components/ai/ai-insight';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Event = Tables<'calendar_events'>;
type Member = Tables<'family_members'>;
type Rsvp = Tables<'event_rsvps'>;

const OPTIONS: { value: 'accepted' | 'declined' | 'maybe'; label: string; icon: typeof Check; cls: string }[] = [
  { value: 'accepted', label: 'Going', icon: Check, cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  { value: 'maybe', label: 'Maybe', icon: HelpCircle, cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  { value: 'declined', label: "Can't", icon: X, cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
];

function fmtRange(e: Event): string {
  const s = new Date(e.starts_at);
  if (e.all_day) return s.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · All day';
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  const date = s.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const time = s.toLocaleTimeString('en-US', opts) + (e.ends_at ? ` – ${new Date(e.ends_at).toLocaleTimeString('en-US', opts)}` : '');
  return `${date} · ${time}`;
}

export function EventDetailModal({ event, members, selfMemberId, familyId, onClose, onEdit, onDeleted }: {
  event: Event; members: Member[]; selfMemberId: string | null; familyId: string; onClose: () => void;
  onEdit?: (event: Event) => void; onDeleted?: () => void;
}) {
  const { error: toastError } = useToast();
  const [rsvps, setRsvps] = useState<Rsvp[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function deleteEvent() {
    if (deleting) return;
    setDeleting(true);
    try {
      // Through the service, which filters `family_id` as well as `id`. The
      // client delete filtered on `id` alone and left tenancy entirely to RLS —
      // one policy between a mistyped id and another household's event.
      const result = await deleteCalendarEventAction(event.id);
      if (!result.ok) { toastError(result.error); return; }
      onDeleted?.();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setDeleting(false);
    }
  }
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    void supabase.from('event_rsvps').select('*').eq('event_id', event.id).then(({ data }) => {
      if (active) setRsvps(data ?? []);
    });
    return () => { active = false; };
  }, [event.id]);

  const mine = rsvps.find((r) => r.member_id === selfMemberId)?.status ?? null;
  const grouped = useMemo(() => {
    const g: Record<string, Rsvp[]> = { accepted: [], maybe: [], declined: [] };
    for (const r of rsvps) (g[r.status] ??= []).push(r);
    return g;
  }, [rsvps]);

  async function respond(status: 'accepted' | 'declined' | 'maybe') {
    if (!selfMemberId || saving) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from('event_rsvps')
        .upsert({ event_id: event.id, family_id: familyId, member_id: selfMemberId, status }, { onConflict: 'event_id,member_id' })
        .select('*');
      if (error) { toastError(describeDbError(error)); return; }
      // Merge the saved row back into local state.
      setRsvps((prev) => {
        const others = prev.filter((r) => r.member_id !== selfMemberId);
        return data && data[0] ? [...others, data[0]] : others;
      });
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={event.title}>
      <div className="space-y-4">
        <div className="space-y-1.5 text-sm text-muted">
          <p className="flex items-center gap-2"><CalendarDays className="h-4 w-4" />{fmtRange(event)}</p>
          {event.location && <p className="flex items-center gap-2"><MapPin className="h-4 w-4" />{event.location}</p>}
          {event.assignee_id && memberById.get(event.assignee_id) && (
            <p className="flex items-center gap-2"><Clock className="h-4 w-4" />Owner: {memberById.get(event.assignee_id)!.display_name}</p>
          )}
        </div>
        {event.description && <p className="whitespace-pre-wrap text-sm text-fg/90">{event.description}</p>}

        <AiInsight kind="event" params={{ eventId: event.id }} variant="outline" className="w-full" label="AI prep checklist" />

        {selfMemberId && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Your RSVP</p>
            <div className="grid grid-cols-3 gap-2">
              {OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => respond(o.value)}
                  disabled={saving}
                  className={cn('flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-semibold transition disabled:opacity-60',
                    mine === o.value ? o.cls : 'border-border text-muted hover:bg-elevated')}
                >
                  <o.icon className="h-4 w-4" /> {o.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {OPTIONS.map((o) => {
            const list = grouped[o.value] ?? [];
            if (list.length === 0) return null;
            return (
              <div key={o.value} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-xs text-muted">{o.label} ({list.length})</span>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((r) => {
                    const m = memberById.get(r.member_id);
                    return m ? <Avatar key={r.id} name={m.display_name} color={m.color} size={26} /> : null;
                  })}
                </div>
              </div>
            );
          })}
          {rsvps.length === 0 && <p className="text-sm text-muted">No RSVPs yet — be the first to respond.</p>}
        </div>

        {/* Edit / delete — any family member (family-scoped RLS governs). Delete
            uses a two-tap confirm; for a recurring event it removes the SERIES. */}
        {(onEdit || onDeleted) && (
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            {confirmDelete ? (
              <>
                <span className="mr-auto text-xs text-danger">
                  {event.recurrence !== 'none' ? 'Delete the whole recurring series?' : 'Delete this event?'}
                </span>
                <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted transition hover:bg-elevated">
                  Keep
                </button>
                <button type="button" onClick={() => void deleteEvent()} disabled={deleting}
                  className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60">
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </>
            ) : (
              <>
                {onDeleted && (
                  <button type="button" onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted transition hover:border-danger/50 hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                )}
                {onEdit && (
                  <button type="button" onClick={() => onEdit(event)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-elevated">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
