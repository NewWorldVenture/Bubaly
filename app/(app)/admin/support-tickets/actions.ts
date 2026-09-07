'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { describeActionError } from '@/lib/supabase/errors';
import { emailSchema } from '@/lib/validation';
import type { Database } from '@/lib/database.types';

type ActionResult = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type GuardResult = { supabase: AdminClient } | { ok: false; error: string };
type TicketUpdate = Database['public']['Tables']['support_tickets']['Update'];

const CATEGORIES = new Set(['technical', 'billing', 'account', 'family', 'general', 'feature_request']);
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

function actionFailure(operation: string, error: unknown): ActionResult {
  console.error(`[support-tickets] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

async function guard(): Promise<GuardResult> {
  const t = await getTranslations();
  if (!(await isSuperAdmin())) return { ok: false, error: t('actions.notAuthorized') };
  return { supabase: createServiceClient() };
}

async function updateTicket(
  ticketId: string,
  patch: TicketUpdate,
  operation: string,
): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  if (!ticketId.trim()) return { ok: false, error: t('actions.aTicketIsRequired') };
  const { data, error } = await guarded.supabase
    .from('support_tickets')
    .update(patch)
    .eq('id', ticketId)
    .select('id')
    .maybeSingle();
  if (error) return actionFailure(operation, error);
  if (!data) return { ok: false, error: t('actions.ticketNotFound') };
  revalidatePath('/admin/support-tickets');
  return { ok: true };
}

export async function resolveTicketAction(ticketId: string): Promise<ActionResult> {
  return updateTicket(ticketId, {
    status: 'resolved', resolved_at: new Date().toISOString(),
  }, 'resolve that ticket');
}

export async function closeTicketAction(ticketId: string): Promise<ActionResult> {
  return updateTicket(ticketId, {
    status: 'closed', closed_at: new Date().toISOString(),
  }, 'close that ticket');
}

export async function reopenTicketAction(ticketId: string): Promise<ActionResult> {
  return updateTicket(ticketId, {
    status: 'open', resolved_at: null, closed_at: null,
  }, 'reopen that ticket');
}

export async function createTicketAction(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();
  const guarded = await guard();
  if (!('supabase' in guarded)) return guarded;
  const subject = String(formData.get('subject') ?? '').trim().slice(0, 240);
  const category = String(formData.get('category') ?? 'general');
  const priority = String(formData.get('priority') ?? 'medium');
  const parsedEmail = emailSchema.safeParse(String(formData.get('requester_email') ?? ''));
  const requester_name = String(formData.get('requester_name') ?? '').trim().slice(0, 120) || null;
  const description = String(formData.get('description') ?? '').trim().slice(0, 4000) || null;

  if (!subject) return { ok: false, error: t('actions.aSubjectIsRequired') };
  if (!parsedEmail.success) return { ok: false, error: t('actions.enterAValidRequesterEmail') };
  if (!CATEGORIES.has(category)) return { ok: false, error: t('actions.chooseAValidTicketCategory') };
  if (!PRIORITIES.has(priority)) return { ok: false, error: t('actions.chooseAValidTicketPriority') };

  // Do not derive a unique identifier from count + 1: concurrent admins can
  // observe the same count and collide on support_tickets.ticket_number.
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const ticket_number = `TKT-${dateStr}-${crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;

  const { error } = await guarded.supabase.from('support_tickets').insert({
    ticket_number, subject, category, priority,
    requester_email: parsedEmail.data, requester_name, description,
  });
  if (error) return actionFailure('create that ticket', error);
  revalidatePath('/admin/support-tickets');
  return { ok: true };
}
