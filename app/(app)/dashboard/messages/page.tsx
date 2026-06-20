import type { Metadata } from 'next';
import { MessagesModule } from '@/components/modules/messages-module';

export const metadata: Metadata = { title: 'Family Messages' };

export default function MessagesPage() {
  return <MessagesModule />;
}
