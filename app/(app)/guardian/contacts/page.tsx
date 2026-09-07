import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { ContactList } from '@/components/guardian/contact-list';
import { Users, ArrowLeft } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Trust Graph · AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const [{ data: contacts }, { data: members }] = await Promise.all([
    (db.from('guardian_contacts') as ReturnType<typeof supabase.from>)
      .select('id, name, phone, email, trust_level, trust_override, notes, total_calls, total_sms, last_contact_at, spam_score')
      .eq('family_id', familyId)
      .order('name', { ascending: true }),

    supabase
      .from('family_members')
      .select('id, display_name')
      .eq('family_id', familyId)
      .eq('is_active', true),
  ]);

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
          <p className="text-sm text-muted">{contacts?.length ?? 0} contacts</p>
        </div>
      </div>

      <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-3">
        <p className="text-xs text-blue-300">{t('contacts.trustLevelsControlHowBubaly')}</p>
      </div>

      <ContactList
        contacts={(contacts ?? []) as unknown as Parameters<typeof ContactList>[0]['contacts']}
        members={(members ?? []) as Parameters<typeof ContactList>[0]['members']}
      />
    </div>
  );
}
