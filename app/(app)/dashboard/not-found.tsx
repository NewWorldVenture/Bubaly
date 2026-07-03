import { AppNotFound } from '@/components/app/app-not-found';

// Renders inside the dashboard's AppFrame, so notFound() on a missing record
// (post, campaign, survey, sync account…) keeps the nav chrome.
export default function DashboardNotFound() {
  return <AppNotFound backHref="/dashboard" backLabel="Go to dashboard" />;
}
