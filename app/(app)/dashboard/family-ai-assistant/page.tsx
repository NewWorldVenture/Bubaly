import type { Metadata } from 'next';
import { AssistantModule } from '@/components/modules/assistant-module';

export const metadata: Metadata = { title: 'Family AI Assistant' };

// The assistant persists every conversation to ai_conversations / ai_messages
// via /api/ai/chat. This route is the canonical Family OS entry point for it.
export default function FamilyAiAssistantPage() {
  return <AssistantModule />;
}
