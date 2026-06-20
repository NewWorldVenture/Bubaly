import { redirect } from 'next/navigation';

// The parent command center is the Family Operations dashboard.
export default function ParentPage() {
  redirect('/dashboard/family-operations');
}
