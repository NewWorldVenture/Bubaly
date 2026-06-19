import type { Metadata } from 'next';
import { ChoresModule } from '@/components/modules/chores-module';

export const metadata: Metadata = { title: 'Chores' };

export default function ChoresPage() {
  return <ChoresModule />;
}
