'use client';

import { useRef, useState } from 'react';
import { Sparkles, Clock, CalendarCheck, Loader2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { describeDbError } from '@/lib/supabase/errors';
import { createCalendarEventAction } from '@/app/(app)/dashboard/calendar/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

type Member = ReturnType<typeof useApp>['members'][number];
type Slot = { startISO: string; endISO: string };

const DURATIONS = [
  { label: '30 min', min: 30 },
  { label: '1 hour', min: 60 },
  { label: '90 min', min: 90 },
  { label: '2 hours', min: 120 },
];
const WINDOWS = [
  { label: 'Next 7 days', days: 7 },
  { label: 'Next 2 weeks', days: 14 },
  { label: 'Next 30 days', days: 30 },
];

/**
 * AI "find a time everyone is free" flow. Reads each selected person's calendar
 * (events + school + sports) via /api/ai/schedule, surfaces open slots, and books
 * one in a tap. Working hours keep suggestions inside a humane part of the day.
 */
export function FindTimeModal({
  members, selfMemberId, onClose, onScheduled,
}: { members: Member[]; selfMemberId: string | null; onClose: () => void; onScheduled: () => void }) {
  const { success, error: toastError } = useToast();

  const [selectedMembers, setSelectedMembers] = useState<string[]>(
    selfMemberId ? [selfMemberId] : [],
  );
  const [durationMin, setDurationMin] = useState(60);
  const [windowDays, setWindowDays] = useState(7);
  const [workdayOnly, setWorkdayOnly] = useState(true);
  const [title, setTitle] = useState('');

  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [booking, setBooking] = useState<string | null>(null);

  function toggleMember(id: string) {
    setSelectedMembers((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
    setSearched(false);
  }

  async function findTimes() {
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch('/api/ai/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberIds: selectedMembers,
          durationMin,
          windowEndISO: new Date(Date.now() + windowDays * 86400000).toISOString(),
          workingHours: workdayOnly ? { startHour: 8, endHour: 20 } : { startHour: 6, endHour: 23 },
          maxSuggestions: 8,
        }),
      });
      const json = (await res.json()) as { slots?: Slot[]; error?: string };
      if (json.error) throw new Error(json.error);
      setSlots(json.slots ?? []);
    } catch (err) {
      toastError(describeDbError(err, 'Could not find times'));
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }

  // One submission id per slot, minted on first tap and kept for the life of this
  // modal. Tapping the same slot again after a failure is the same booking and is
  // deduplicated; tapping a different slot is a different booking and is not.
  const bookingIds = useRef(new Map<string, string>());
  function bookingIdFor(slotStart: string): string {
    const held = bookingIds.current.get(slotStart);
    if (held) return held;
    const minted = newSubmissionId();
    bookingIds.current.set(slotStart, minted);
    return minted;
  }

  async function book(slot: Slot) {
    setBooking(slot.startISO);
    try {
      // A meeting for several people books under the family; one person → that person.
      const assigneeId = selectedMembers.length === 1 ? selectedMembers[0] : null;
      const result = await createCalendarEventAction({
        title: title.trim() || 'New event',
        category: 'general',
        assigneeId,
        startsAt: slot.startISO,
        endsAt: slot.endISO,
        allDay: false,
        recurrence: 'none',
        submissionId: bookingIdFor(slot.startISO),
      });
      if (!result.ok) { toastError(result.error); return; }
      success('Event scheduled');
      onScheduled();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setBooking(null);
    }
  }

  const fmtSlot = (s: Slot) => {
    const start = new Date(s.startISO);
    const end = new Date(s.endISO);
    const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const t = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return { day, time: `${t(start)} – ${t(end)}` };
  };

  return (
    <Modal open title="Find a time" onClose={onClose}>
      <div className="space-y-4">
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Sparkles className="h-3.5 w-3.5 text-brand-text" />
          We&apos;ll scan everyone&apos;s calendars and surface slots where they&apos;re all free.
        </p>

        {/* Who */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">Who needs to be free</label>
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {members.map((m) => {
              const on = selectedMembers.includes(m.id);
              return (
                <button key={m.id} type="button" onClick={() => toggleMember(m.id)}
                  className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                    on ? 'border-brand/50 bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                  <Avatar name={m.display_name} color={m.color} size={16} />
                  {m.display_name}
                </button>
              );
            })}
          </div>
          {selectedMembers.length === 0 && (
            <p className="mt-1 text-[11px] text-muted">No one selected → searches the whole family&apos;s shared time.</p>
          )}
        </div>

        {/* Duration */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">How long</label>
          <div className="flex flex-wrap gap-1.5">
            {DURATIONS.map((d) => (
              <button key={d.min} type="button" onClick={() => { setDurationMin(d.min); setSearched(false); }}
                className={cn('rounded-full border px-3 py-1 text-xs font-medium transition',
                  durationMin === d.min ? 'border-brand/50 bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* Window */}
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">Within</label>
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS.map((w) => (
              <button key={w.days} type="button" onClick={() => { setWindowDays(w.days); setSearched(false); }}
                className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition',
                  windowDays === w.days ? 'border-brand/50 bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={workdayOnly} onChange={(e) => { setWorkdayOnly(e.target.checked); setSearched(false); }} className="accent-brand" />
          Keep it to daytime hours (8am–8pm)
        </label>

        <Button onClick={findTimes} loading={loading} className="w-full">
          {loading ? 'Scanning calendars…' : <><Sparkles className="h-4 w-4" /> Find open times</>}
        </Button>

        {/* Results */}
        {searched && !loading && (
          <div className="border-t border-border pt-3">
            {slots.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted">
                No shared openings in this window. Try a shorter duration or a wider range.
              </p>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted">{slots.length} open slot{slots.length === 1 ? '' : 's'}</span>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title (optional)" className="h-7 max-w-[55%] text-xs" />
                </div>
                <div className="max-h-60 space-y-1.5 overflow-y-auto">
                  {slots.map((s) => {
                    const f = fmtSlot(s);
                    const busy = booking === s.startISO;
                    return (
                      <button key={s.startISO} type="button" disabled={busy} onClick={() => book(s)}
                        className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-left transition hover:border-brand/50 hover:bg-elevated disabled:opacity-60">
                        <Clock className="h-4 w-4 shrink-0 text-brand-text" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold">{f.day}</div>
                          <div className="text-xs text-muted">{f.time}</div>
                        </div>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted" /> : <CalendarCheck className="h-4 w-4 shrink-0 text-muted" />}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted">Tap a slot to book it instantly.</p>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
