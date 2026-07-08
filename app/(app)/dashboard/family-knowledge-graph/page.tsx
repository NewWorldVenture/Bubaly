import { redirect } from 'next/navigation';

// R4 (de-dup): the "Family Knowledge Graph" was a second view of the same
// graph_entities/graph_edges the Reasoning Graph renders (and which the whole
// R1/R2 reasoning layer is built on). Consolidated into /dashboard/graph; this
// route redirects so existing links keep working.
export default function FamilyKnowledgeGraphPage() {
  redirect('/dashboard/graph');
}
