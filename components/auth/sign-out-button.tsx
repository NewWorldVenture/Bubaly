'use client';

// Sign-out trigger with an "Are you sure?" confirmation step (the logout-confirm
// mockup). The trigger looks like whatever the call site passes via children +
// className; confirming POSTs the real /auth/signout form (server clears the
// Supabase session and redirects). Cancelling just closes the sheet.
import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

export function SignOutButton({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {children ?? (<><LogOut className="h-4 w-4" /> Sign out</>)}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Sign out?"
        description="You’ll need to sign in again to get back to your family."
      >
        <form
          action="/auth/signout"
          method="post"
          onSubmit={() => setSigningOut(true)}
          className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"
        >
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={signingOut}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={signingOut}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </form>
      </Modal>
    </>
  );
}
