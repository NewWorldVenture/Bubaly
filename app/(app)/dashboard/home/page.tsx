import type { Metadata } from 'next';
import { HomeModule } from '@/components/modules/home-module';

export const metadata: Metadata = { title: 'Home & Maintenance' };

export default function HomePage() {
  return <HomeModule />;
}
