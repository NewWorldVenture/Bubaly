import type { Metadata } from 'next';
import { AssistantModule } from '@/components/modules/assistant-module';

export const metadata: Metadata = { title: 'AI Assistant' };

export default function AssistantPage() {
  return <AssistantModule />;
}
