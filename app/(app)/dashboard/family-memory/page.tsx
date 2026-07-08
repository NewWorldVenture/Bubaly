import { redirect } from 'next/navigation';

// R4 (de-dup): "Memory Brain" duplicated the Memories destination — its
// family_memories journal + milestones already surface on Memories'
// neighbours (grandparent-portal, planning), and Memories is the richer,
// free-tier home for the same concept. Consolidated; this route redirects so
// existing links keep working. (The distinct Knowledge Base / family_facts
// surface is intentionally left alone — it's facts, not memories.)
export default function FamilyMemoryPage() {
  redirect('/dashboard/memories');
}
