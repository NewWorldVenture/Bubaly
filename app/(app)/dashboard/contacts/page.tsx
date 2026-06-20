import type { Metadata } from 'next';
import { ContactsModule } from '@/components/modules/contacts-module';

export const metadata: Metadata = { title: 'Family Contacts' };

export default function ContactsPage() {
  return <ContactsModule />;
}
