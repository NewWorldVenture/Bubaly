import type { Metadata } from 'next';
import { GoalsModule } from '@/components/modules/goals-module';

export const metadata: Metadata = { title: 'Goals' };

export default function GoalsPage() {
  return <GoalsModule />;
}
