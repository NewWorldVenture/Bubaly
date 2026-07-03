import { AppNotFound } from '@/components/app/app-not-found';

// Renders inside the wallet's AppFrame, so notFound() on a missing child wallet
// keeps the nav chrome.
export default function WalletNotFound() {
  return (
    <AppNotFound
      title="That wallet isn’t here"
      description="This child wallet may have been removed, or the link is out of date."
      backHref="/wallet"
      backLabel="Back to Wallet"
    />
  );
}
