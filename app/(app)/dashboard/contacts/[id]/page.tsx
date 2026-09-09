import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  buildContactTimeline, contactHealth,
  type LoggedInteraction, type CommunicationLike,
} from '@/lib/contacts/timeline';
import { ContactTimelineModule } from '@/components/modules/contact-timeline-module';
import type { Tables } from '@/lib/database.types';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Contact Timeline' };
export const dynamic = 'force-dynamic';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('contacts.contactTimeline')}</h1>
      <ErrorState message={t('contacts.couldNotLoadThisContact')} />
      <Link href="/dashboard/contacts" className="text-sm font-medium text-brand-text underline">{t('contacts.backToContacts')}</Link>
    </div>
  );
}

/**
 * Per-contact relationship timeline: everything the family knows about one
 * person — logged interactions, inbox communications, birthdays — plus a
 * relationship-health read (last touch vs. this relationship's natural cadence).
 */
export default async function ContactTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const { id } = await params;
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const { data: contact, error: contactError } = await supabase
    .from('family_contacts').select('*')
    .eq('id', id).eq('family_id', familyId).maybeSingle();
  if (contactError) {
    console.error('[dashboard-contact-timeline] contact read failed', contactError);
    return <ReadFailure />;
  }
  if (!contact) notFound();

  // Logged interactions — degrades safely before migration 0170.
  let interactions: Tables<'contact_interactions'>[] = [];
  let interactionsError: unknown = null;
  try {
    const { data, error } = await supabase
      .from('contact_interactions').select('*')
      .eq('contact_id', id).eq('family_id', familyId)
      .order('occurred_on', { ascending: false }).limit(500);
    interactions = (data ?? []) as Tables<'contact_interactions'>[];
    interactionsError = error;
  } catch { /* table not applied yet */ }
  if (interactionsError) {
    console.error('[dashboard-contact-timeline] interaction read failed', interactionsError);
    return <ReadFailure />;
  }

  // Inbox communications linked to this contact (best-effort).
  let comms: CommunicationLike[] = [];
  let communicationsError: unknown = null;
  try {
    const { data, error } = await supabase
      .from('family_communications')
      .select('id, channel, direction, subject, summary, received_at')
      .eq('contact_id', id).eq('family_id', familyId)
      .order('received_at', { ascending: false }).limit(200);
    comms = (data ?? []) as CommunicationLike[];
    communicationsError = error;
  } catch { /* table not present in this env */ }
  if (communicationsError) {
    console.error('[dashboard-contact-timeline] communication read failed', communicationsError);
    return <ReadFailure />;
  }

  const timeline = buildContactTimeline({
    t,
    interactions: interactions.map((i): LoggedInteraction => ({
      id: i.id, kind: i.kind as LoggedInteraction['kind'], occurred_on: i.occurred_on,
      title: i.title, note: i.note, amount: i.amount,
    })),
    communications: comms,
    birthdayMonth: contact.birthday_month,
    birthdayDay: contact.birthday_day,
  });
  const health = contactHealth(timeline, contact.name, t);

  return (
    <ContactTimelineModule
      contact={contact}
      timeline={timeline}
      health={health}
      interactionIds={interactions.map((i) => i.id)}
    />
  );
}
