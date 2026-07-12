import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  buildContactTimeline, contactHealth,
  type LoggedInteraction, type CommunicationLike,
} from '@/lib/contacts/timeline';
import { ContactTimelineModule } from '@/components/modules/contact-timeline-module';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'Contact Timeline' };
export const dynamic = 'force-dynamic';

/**
 * Per-contact relationship timeline: everything the family knows about one
 * person — logged interactions, inbox communications, birthdays — plus a
 * relationship-health read (last touch vs. this relationship's natural cadence).
 */
export default async function ContactTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const { data: contact } = await supabase
    .from('family_contacts').select('*')
    .eq('id', id).eq('family_id', familyId).maybeSingle();
  if (!contact) notFound();

  // Logged interactions — degrades safely before migration 0170.
  let interactions: Tables<'contact_interactions'>[] = [];
  try {
    const { data } = await supabase
      .from('contact_interactions').select('*')
      .eq('contact_id', id).eq('family_id', familyId)
      .order('occurred_on', { ascending: false }).limit(500);
    interactions = (data ?? []) as Tables<'contact_interactions'>[];
  } catch { /* table not applied yet */ }

  // Inbox communications linked to this contact (best-effort).
  let comms: CommunicationLike[] = [];
  try {
    const { data } = await supabase
      .from('family_communications')
      .select('id, channel, direction, subject, summary, received_at')
      .eq('contact_id', id).eq('family_id', familyId)
      .order('received_at', { ascending: false }).limit(200);
    comms = (data ?? []) as CommunicationLike[];
  } catch { /* table not present in this env */ }

  const timeline = buildContactTimeline({
    interactions: interactions.map((i): LoggedInteraction => ({
      id: i.id, kind: i.kind as LoggedInteraction['kind'], occurred_on: i.occurred_on,
      title: i.title, note: i.note, amount: i.amount,
    })),
    communications: comms,
    birthdayMonth: contact.birthday_month,
    birthdayDay: contact.birthday_day,
  });
  const health = contactHealth(timeline, contact.name);

  return (
    <ContactTimelineModule
      contact={contact}
      timeline={timeline}
      health={health}
      interactionIds={interactions.map((i) => i.id)}
    />
  );
}
