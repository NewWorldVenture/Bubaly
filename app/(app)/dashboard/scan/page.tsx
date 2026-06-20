import type { Metadata } from 'next';
import { ScanModule } from '@/components/modules/scan-module';

export const metadata: Metadata = { title: 'Scan Flyer' };

export default function ScanPage() {
  return <ScanModule />;
}
