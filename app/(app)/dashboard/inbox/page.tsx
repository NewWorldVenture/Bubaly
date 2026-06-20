import type { Metadata } from 'next';
import { InboxModule } from '@/components/modules/inbox-module';

export const metadata: Metadata = { title: 'Magic Import Inbox' };

export default function InboxPage() {
  return <InboxModule />;
}
