import { redirect } from 'next/navigation';

// R4 (de-dup): the "Family AI Assistant" was a duplicate of the AI Assistant —
// both rendered the same AssistantModule. Consolidated into the one assistant;
// this route redirects so existing links keep working.
export default function FamilyAiAssistantPage() {
  redirect('/dashboard/assistant');
}
