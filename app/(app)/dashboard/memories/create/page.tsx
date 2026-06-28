import type { Metadata } from 'next';
import { CreateMemory } from '@/components/memories/create-memory';

export const metadata: Metadata = { title: 'Create memory' };

export default function CreateMemoryPage() {
  return <CreateMemory />;
}
