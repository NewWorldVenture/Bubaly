'use server';

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/supabase/auth';

async function guard() {
  if (!(await isSuperAdmin())) throw new Error('Unauthorized');
  return createServiceClient();
}

export async function resolveTicketAction(ticketId: string) {
  const supabase = await guard();
  await supabase
    .from('support_tickets')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('id', ticketId);
  revalidatePath('/admin/support-tickets');
}

export async function closeTicketAction(ticketId: string) {
  const supabase = await guard();
  await supabase
    .from('support_tickets')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', ticketId);
  revalidatePath('/admin/support-tickets');
}

export async function reopenTicketAction(ticketId: string) {
  const supabase = await guard();
  await supabase
    .from('support_tickets')
    .update({ status: 'open', resolved_at: null, closed_at: null })
    .eq('id', ticketId);
  revalidatePath('/admin/support-tickets');
}

export async function createTicketAction(formData: FormData) {
  const supabase = await guard();
  const subject = String(formData.get('subject') ?? '').trim();
  const category = String(formData.get('category') ?? 'general');
  const priority = String(formData.get('priority') ?? 'medium');
  const requester_email = String(formData.get('requester_email') ?? '').trim();
  const requester_name = String(formData.get('requester_name') ?? '').trim() || null;
  const description = String(formData.get('description') ?? '').trim() || null;

  if (!subject || !requester_email) return;

  // Generate ticket number
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const { count } = await supabase
    .from('support_tickets')
    .select('id', { count: 'exact', head: true })
    .like('ticket_number', `TKT-${dateStr}%`);
  const seq = String((count ?? 0) + 1).padStart(3, '0');
  const ticket_number = `TKT-${dateStr}-${seq}`;

  await supabase.from('support_tickets').insert({
    ticket_number, subject, category, priority,
    requester_email, requester_name, description,
  });
  revalidatePath('/admin/support-tickets');
}
