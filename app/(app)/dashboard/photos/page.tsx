import type { Metadata } from 'next';
import { PhotosModule } from '@/components/modules/photos-module';

export const metadata: Metadata = { title: 'Family Photos' };

export default function PhotosPage() {
  return <PhotosModule />;
}
