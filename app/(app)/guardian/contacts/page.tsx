import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { settle } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { ContactList } from '@/components/guardian/contact-list';
import { ErrorState } from '@/components/ui/states';
import { Users, ArrowLeft } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.trustGraph')} · ${t('navLabel.aiCallGuardian')}` };
}
export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // The trust graph decides which callers reach a child. "0 contacts" and an
  // empty list on a failed read says the family has trusted nobody, which is a
  // claim about their safety settings rather than a missing screen — so the
  // error is kept and rendered, rather than dropped into an empty list.
  //
  // The second read was already settled and the first was not, which made the
  // batch reject on a transport failure — DNS, TCP, TLS, a timed-out fetch —
  // and take the whole page to the error boundary. That is the failure that
  // took out /dashboard while the database was reporting CONNECT_TIMEOUT; see
  // lib/supabase/settle.ts. Settling both means one unreachable table costs its
  // own list, not the page.
  const [{ data: contacts, error: contactsError }, { data: members, error: membersError }] = await Promise.all([
    // The `as ReturnType<typeof supabase.from>` cast erases the row type, so
    // settle's inference has nothing to carry through — the shape is named here
    // instead. The page already re-casts at the consumption site below.
    settle<{ data: unknown[] | null; error: { message: string } | null }>(supabase.from('guardian_contacts')
      .select('id, name, phone, email, trust_level, trust_override, notes, total_calls, total_sms, last_contact_at, spam_score')
      .eq('family_id', familyId)
      .order('name', { ascending: true })),

    settle(supabase
      .from('family_members')
      .select('id, display_name')
      .eq('family_id', familyId)
      .eq('is_active', true)),
  ]);

  // The degradation above is deliberate. The SILENCE was not: an empty contact
  // list looked identical whether the family has no contacts or the table was
  // unreachable, with nothing written down either way.
  if (contactsError) console.error('[guardian/contacts] contact read failed', contactsError);
  if (membersError) console.error('[guardian/contacts] member read failed', membersError);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/guardian" className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-500/15">
          <Users className="h-5 w-5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">{t('guardianContacts.familyTrustGraph')}</h1>
          <p className="text-sm text-muted">{contactsError ? '—' : `${contacts?.length ?? 0} contacts`}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-3">
        <p className="text-xs text-blue-300">{t('contacts.trustLevelsControlHowBubaly')}</p>
      </div>

      {contactsError ? <ErrorState message={t('guardianContacts.couldnTLoadYourTrustGraph')} /> : (
        <ContactList
          contacts={(contacts ?? []) as unknown as Parameters<typeof ContactList>[0]['contacts']}
          members={(members ?? []) as Parameters<typeof ContactList>[0]['members']}
        />
      )}
    </div>
  );
}
