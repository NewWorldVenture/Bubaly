import type { Metadata } from 'next';
import { SportsModule } from '@/components/modules/sports-module';

export const metadata: Metadata = { title: 'Sports' };

export default function SportsPage() {
  return <SportsModule />;
}
