import type { Metadata } from 'next';
import { SchoolModule } from '@/components/modules/school-module';

export const metadata: Metadata = { title: 'School' };

export default function SchoolPage() {
  return <SchoolModule />;
}
