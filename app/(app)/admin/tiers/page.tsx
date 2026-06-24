import { redirect } from 'next/navigation';

// The Tier & Features admin lives at /admin/tier-features. This path is kept as
// a permanent redirect so older links don't 404.
export default function TiersRedirect() {
  redirect('/admin/tier-features');
}
