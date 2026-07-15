import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import type { AdminNoteKind } from '@/lib/admin/notifications';

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Record one entry in the Super Admin Notification Center (admin_notifications).
 * Best-effort: never throws, so it can't break the flow that triggered it (a
 * support ticket, a marketplace report). Service-role only — the table has no
 * client policies. Requires a SERVICE client (RLS denies user clients).
 */
export async function recordAdminNotification(admin: Admin, input: {
  kind: AdminNoteKind; title: string; body?: string | null; url?: string | null;
  relatedType?: string | null; relatedId?: string | null; meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await admin.from('admin_notifications').insert({
      kind: input.kind,
      title: input.title.slice(0, 300),
      body: input.body ? input.body.slice(0, 2000) : null,
      url: input.url ?? null,
      related_type: input.relatedType ?? null,
      related_id: input.relatedId ?? null,
      meta: (input.meta ?? {}) as never,
    });
  } catch (e) {
    console.error('[admin-notify] insert failed', e);
  }
}
