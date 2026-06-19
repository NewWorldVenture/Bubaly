import type { Metadata } from 'next';
import { DocumentsModule } from '@/components/modules/documents-module';

export const metadata: Metadata = { title: 'Documents' };

export default function DocumentsPage() {
  return <DocumentsModule />;
}
