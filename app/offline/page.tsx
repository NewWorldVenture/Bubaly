import { WifiOff } from 'lucide-react';

export const metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand">
        <WifiOff className="h-7 w-7" />
      </div>
      <h1 className="text-2xl font-semibold">You’re offline</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        Bubaly will reconnect automatically. Recently viewed screens are still available.
      </p>
    </div>
  );
}
