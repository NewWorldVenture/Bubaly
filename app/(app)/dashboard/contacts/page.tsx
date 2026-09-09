import type { Metadata } from 'next';
import { ContactsModule } from '@/components/modules/contacts-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('contacts.familyContacts') };
}

export default function ContactsPage() {
  return <ContactsModule />;
}
