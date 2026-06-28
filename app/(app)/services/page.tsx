import type { Metadata } from 'next';
import { ServicesHub } from '@/components/services/services-hub';

export const metadata: Metadata = { title: 'All Services' };

export default function ServicesPage() {
  return <ServicesHub />;
}
