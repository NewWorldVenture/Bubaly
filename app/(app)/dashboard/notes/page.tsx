import type { Metadata } from 'next';
import { NotesModule } from '@/components/modules/notes-module';

export const metadata: Metadata = { title: 'Notes' };

export default function NotesPage() {
  return <NotesModule />;
}
