import type { Metadata } from 'next';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';

export const metadata: Metadata = { title: 'Dental' };

export default function DentalPage() {
  return <MedicalRecordsModule kind="dental" />;
}
