import type { Metadata } from 'next';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';

export const metadata: Metadata = { title: 'Medical' };

export default function MedicalPage() {
  return <MedicalRecordsModule kind="medical" />;
}
