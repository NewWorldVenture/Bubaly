import type { Metadata } from 'next';
import { HealthModule } from '@/components/modules/health-module';

export const metadata: Metadata = { title: 'Health' };

export default function HealthPage() {
  return <HealthModule />;
}
