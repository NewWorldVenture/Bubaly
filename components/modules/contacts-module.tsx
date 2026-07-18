'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  Users, Plus, Phone, Mail, MapPin, Star, Trash2, Edit2,
  Search, User, Stethoscope, GraduationCap, Trophy, Home,
  AlertTriangle, HeartPulse, Smile, Briefcase, ChevronRight,
  X, Copy, ExternalLink,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { isValidEmail, isValidPhone } from '@/lib/utils/validation';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Contact = Tables<'family_contacts'>;

const CATEGORIES = [
  { id: 'emergency', label: 'Emergency', icon: AlertTriangle, color: 'text-danger', bg: 'bg-danger/10', badge: 'danger' },
  { id: 'family', label: 'Family', icon: Home, color: 'text-brand-text', bg: 'bg-brand/10', badge: 'brand' },
  { id: 'doctor', label: 'Doctor', icon: Stethoscope, color: 'text-success', bg: 'bg-success/10', badge: 'success' },
  { id: 'dentist', label: 'Dentist', icon: Smile, color: 'text-success', bg: 'bg-success/10', badge: 'success' },
  { id: 'teacher', label: 'Teacher', icon: GraduationCap, color: 'text-accent', bg: 'bg-accent/10', badge: 'accent' },
  { id: 'coach', label: 'Coach', icon: Trophy, color: 'text-warning', bg: 'bg-warning/10', badge: 'warning' },
  { id: 'babysitter', label: 'Babysitter', icon: HeartPulse, color: 'text-pink-400', bg: 'bg-pink-400/10', badge: 'neutral' },
  { id: 'neighbor', label: 'Neighbor', icon: Home, color: 'text-teal-400', bg: 'bg-teal-400/10', badge: 'neutral' },
  { id: 'work', label: 'Work', icon: Briefcase, color: 'text-blue-400', bg: 'bg-blue-400/10', badge: 'neutral' },
  { id: 'friend', label: 'Friend', icon: User, color: 'text-purple-400', bg: 'bg-purple-400/10', badge: 'neutral' },
  { id: 'other', label: 'Other', icon: User, color: 'text-muted', bg: 'bg-muted/10', badge: 'neutral' },
] as const;

function categoryMeta(id: string) {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

function initials(name: string) {
  return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

const AVATAR_COLORS = [
  '#7c5dfa', '#f4996e', '#22c55e', '#3b82f6', '#f59e0b',
  '#ec4899', '#14b8a6', '#ef4444', '#8b5cf6', '#06b6d4',
];

function avatarColor(name: string) {
  const idx = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

export function ContactsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { data: contacts, loading, error, refresh } = useRealtimeQuery<Contact>({
    table: 'family_contacts', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('family_contacts').select('*').eq('family_id', familyId)
        .order('is_emergency', { ascending: false })
        .order('name', { ascending: true }),
  });

  const filtered = useMemo(() => {
    let rows = contacts;
    if (activeCategory !== 'all') rows = rows.filter((c) => c.category === activeCategory);
    if (search) rows = rows.filter((c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search) ||
      c.email?.toLowerCase().includes(search.toLowerCase()) ||
      c.relationship?.toLowerCase().includes(search.toLowerCase()) ||
      c.organization?.toLowerCase().includes(search.toLowerCase())
    );
    return rows;
  }, [contacts, activeCategory, search]);

  const emergencyContacts = contacts.filter((c) => c.is_emergency);

  function deleteContact(id: string) {
    return run(`delete:${id}`, async () => {
      const { error: err } = await createClient().from('family_contacts').delete().eq('id', id);
      if (err) throw err;
      success('Contact deleted');
      void refresh();
      if (selected?.id === id) setSelected(null);
    });
  }

  function callPhone(phone: string) {
    window.open(`tel:${phone.replace(/[^+\d]/g, '')}`);
  }

  function openMaps(address: string) {
    window.open(`https://maps.google.com?q=${encodeURIComponent(address)}`, '_blank');
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Family Contacts"
        description="Your family's people — doctors, teachers, coaches, and everyone else who matters."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="contacts" iconOnly />
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-3 py-2">
              <Search className="h-4 w-4 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts…"
                className="w-36 bg-transparent text-sm placeholder:text-muted outline-none sm:w-48" />
              {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-muted" /></button>}
            </div>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Contact</Button>
          </div>
        }
      />

      {/* Emergency contacts strip */}
      {emergencyContacts.length > 0 && (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-danger">
            <AlertTriangle className="h-4 w-4" /> Emergency Contacts
          </p>
          <div className="flex flex-wrap gap-3">
            {emergencyContacts.map((c) => (
              <button key={c.id} onClick={() => setSelected(c)}
                className="flex items-center gap-3 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-left hover:bg-danger/10 transition">
                <div className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-fg"
                  style={{ background: avatarColor(c.name) }}>
                  {initials(c.name)}
                </div>
                <div>
                  <p className="text-sm font-semibold">{c.name}</p>
                  {c.phone && <p className="text-xs text-danger">{c.phone}</p>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left: list */}
        <div className="flex-1 min-w-0">
          {/* Category filter tabs */}
          <div className="tab-bar mb-4">
            <button onClick={() => setActiveCategory('all')}
              className={cn('tab-item', activeCategory === 'all' ? 'tab-item-active' : 'tab-item-inactive')}>
              All ({contacts.length})
            </button>
            {CATEGORIES.filter((c) => contacts.some((contact) => contact.category === c.id)).map((cat) => (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
                className={cn('tab-item', activeCategory === cat.id ? 'tab-item-active' : 'tab-item-inactive')}>
                <cat.icon className="h-3.5 w-3.5" /> {cat.label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={Users} title="No contacts found"
              description={search ? 'Try a different search term.' : 'Add your family\'s important contacts.'}
              action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add First Contact</Button>} />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border">
              {filtered.map((contact, idx) => {
                const cat = categoryMeta(contact.category);
                const isSelected = selected?.id === contact.id;
                return (
                  <div key={contact.id}
                    onClick={() => setSelected(isSelected ? null : contact)}
                    className={cn(
                      'flex cursor-pointer items-center gap-4 border-b border-border/50 px-4 py-3 transition last:border-0',
                      isSelected ? 'bg-brand/8' : 'hover:bg-elevated/30',
                    )}>
                    {/* Avatar */}
                    <div className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold text-fg"
                      style={{ background: avatarColor(contact.name) }}>
                      {initials(contact.name)}
                      {contact.is_emergency && (
                        <div className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[8px] text-white">!</div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold text-sm">{contact.name}</p>
                        {contact.is_emergency && <Badge tone="danger" className="hidden sm:inline-flex">Emergency</Badge>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted">
                        {contact.relationship && <span>{contact.relationship}</span>}
                        {contact.organization && <span>· {contact.organization}</span>}
                      </div>
                    </div>

                    {/* Category badge */}
                    <Badge tone={cat.badge as 'neutral'}>{cat.label}</Badge>

                    {/* Quick actions */}
                    <div className="flex items-center gap-1.5">
                      {contact.phone && (
                        <button onClick={(e) => { e.stopPropagation(); callPhone(contact.phone!); }}
                          className="hidden rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-success sm:flex">
                          <Phone className="h-4 w-4" />
                        </button>
                      )}
                      {contact.email && (
                        <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()}
                          className="hidden rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-brand-text sm:flex">
                          <Mail className="h-4 w-4" />
                        </a>
                      )}
                      <ChevronRight className={cn('h-4 w-4 text-muted/50 transition', isSelected && 'rotate-90')} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: detail panel */}
        {selected && (
          <div className="w-full lg:w-80 xl:w-96">
            <div className="sticky top-4 rounded-2xl border border-border bg-surface/40 p-5">
              {/* Header */}
              <div className="mb-5 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-bold text-fg"
                    style={{ background: avatarColor(selected.name) }}>
                    {initials(selected.name)}
                  </div>
                  <div>
                    <p className="text-base font-bold">{selected.name}</p>
                    <p className="text-sm text-muted">{selected.relationship}</p>
                    {selected.organization && <p className="text-xs text-muted">{selected.organization}</p>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => setEditing(selected)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg transition">
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button onClick={() => setSelected(null)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg transition">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Category + emergency */}
              <div className="mb-4 flex flex-wrap gap-2">
                {(() => { const cat = categoryMeta(selected.category); return (
                  <span className={cn('flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium', cat.bg, cat.color)}>
                    <cat.icon className="h-3.5 w-3.5" /> {cat.label}
                  </span>
                ); })()}
                <Link href={`/dashboard/contacts/${selected.id}`}
                  className="flex items-center gap-1 rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand-text hover:bg-brand/20 transition">
                  🕰️ Relationship timeline
                </Link>
                {selected.is_emergency && (
                  <span className="flex items-center gap-1 rounded-lg bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger">
                    <AlertTriangle className="h-3.5 w-3.5" /> Emergency
                  </span>
                )}
              </div>

              {/* Contact details */}
              <div className="space-y-3">
                {selected.phone && (
                  <div className="flex items-center justify-between rounded-xl bg-elevated/50 px-3 py-2.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="h-4 w-4 text-success" />
                      <span>{selected.phone}</span>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => navigator.clipboard.writeText(selected.phone!)}
                        className="rounded p-1 text-muted hover:text-fg"><Copy className="h-3.5 w-3.5" /></button>
                      <button onClick={() => callPhone(selected.phone!)}
                        className="rounded p-1 text-muted hover:text-success"><Phone className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                )}
                {selected.phone_alt && (
                  <div className="flex items-center gap-2 rounded-xl bg-elevated/50 px-3 py-2.5 text-sm">
                    <Phone className="h-4 w-4 text-muted" />
                    <span className="text-muted">{selected.phone_alt} (alt)</span>
                  </div>
                )}
                {selected.email && (
                  <div className="flex items-center justify-between rounded-xl bg-elevated/50 px-3 py-2.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="h-4 w-4 text-brand-text" />
                      <span className="truncate">{selected.email}</span>
                    </div>
                    <a href={`mailto:${selected.email}`}
                      className="rounded p-1 text-muted hover:text-brand-text"><ExternalLink className="h-3.5 w-3.5" /></a>
                  </div>
                )}
                {selected.address && (
                  <div className="flex items-start justify-between rounded-xl bg-elevated/50 px-3 py-2.5">
                    <div className="flex items-start gap-2 text-sm">
                      <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
                      <span className="text-muted">{selected.address}</span>
                    </div>
                    <button onClick={() => openMaps(selected.address!)}
                      className="rounded p-1 text-muted hover:text-accent"><ExternalLink className="h-3.5 w-3.5" /></button>
                  </div>
                )}
                {selected.specialty && (
                  <div className="flex items-center gap-2 rounded-xl bg-elevated/50 px-3 py-2.5 text-sm">
                    <Stethoscope className="h-4 w-4 text-muted" />
                    <span className="text-muted">{selected.specialty}</span>
                  </div>
                )}
                {selected.birthday_month && selected.birthday_day && (
                  <div className="flex items-center gap-2 rounded-xl bg-elevated/50 px-3 py-2.5 text-sm">
                    <Star className="h-4 w-4 text-warning" />
                    <span className="text-muted">Birthday: {new Date(2000, selected.birthday_month - 1, selected.birthday_day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</span>
                  </div>
                )}
                {selected.notes && (
                  <div className="rounded-xl bg-elevated/50 px-3 py-2.5">
                    <p className="mb-1 text-xs font-medium text-muted">Notes</p>
                    <p className="text-sm">{selected.notes}</p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="mt-5 grid grid-cols-2 gap-2">
                {selected.phone && (
                  <Button variant="outline" size="sm" onClick={() => callPhone(selected.phone!)}>
                    <Phone className="h-4 w-4" /> Call
                  </Button>
                )}
                {selected.email && (
                  <a href={`mailto:${selected.email}`}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium hover:bg-elevated transition">
                    <Mail className="h-4 w-4" /> Email
                  </a>
                )}
                <Button variant="ghost" size="sm" onClick={() => setEditing(selected)}>
                  <Edit2 className="h-4 w-4" /> Edit
                </Button>
                <Button variant="ghost" size="sm" disabled={isPending(`delete:${selected.id}`)} onClick={() => { if (confirm('Delete this contact?')) deleteContact(selected.id); }}>
                  <Trash2 className="h-4 w-4 text-danger" />
                  <span className="text-danger">{isPending(`delete:${selected.id}`) ? 'Deleting…' : 'Delete'}</span>
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {(addOpen || editing) && (
        <ContactModal
          contact={editing}
          familyId={familyId}
          userId={userId}
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={() => { setAddOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function ContactModal({ contact, familyId, userId, onClose, onSaved }: {
  contact: Contact | null; familyId: string; userId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const g = (key: string) => String(form.get(key) ?? '').trim() || null;
    const payload = {
      name: g('name') ?? '',
      relationship: g('relationship'),
      category: String(form.get('category') ?? 'other'),
      phone: g('phone'),
      phone_alt: g('phone_alt'),
      email: g('email'),
      address: g('address'),
      specialty: g('specialty'),
      organization: g('organization'),
      notes: g('notes'),
      is_emergency: form.get('is_emergency') === 'on',
      birthday_month: form.get('birthday_month') ? Number(form.get('birthday_month')) : null,
      birthday_day: form.get('birthday_day') ? Number(form.get('birthday_day')) : null,
    };
    // ── Validation ──
    if (!payload.name) return toastError('Name is required');
    if (payload.name.length > 120) return toastError('Name is too long (max 120 characters)');
    if (payload.email && !isValidEmail(payload.email)) return toastError('Enter a valid email address (e.g. name@example.com)');
    if (payload.phone && !isValidPhone(payload.phone)) return toastError('Enter a valid phone number');
    if (payload.phone_alt && !isValidPhone(payload.phone_alt)) return toastError('The alternate phone number looks invalid');
    if (payload.birthday_day != null && (payload.birthday_day < 1 || payload.birthday_day > 31)) return toastError('Birthday day must be between 1 and 31');

    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = contact
        ? await supabase.from('family_contacts').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', contact.id)
        : await supabase.from('family_contacts').insert({ ...payload, family_id: familyId, created_by: userId });
      if (error) { toastError(describeDbError(error)); return; }
      success(contact ? 'Contact updated' : 'Contact added');
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={contact ? 'Edit Contact' : 'New Contact'}>
      <form onSubmit={onSubmit} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required>
            {(id) => <Input id={id} name="name" defaultValue={contact?.name ?? ''} placeholder="Jane Smith" autoFocus />}
          </Field>
          <Field label="Relationship">
            {(id) => <Input id={id} name="relationship" defaultValue={contact?.relationship ?? ''} placeholder="Mom's doctor, Emma's teacher…" />}
          </Field>
        </div>

        <Field label="Category">
          {() => (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {CATEGORIES.map((cat) => (
                <label key={cat.id} className="relative cursor-pointer">
                  <input type="radio" name="category" value={cat.id} defaultChecked={contact ? contact.category === cat.id : cat.id === 'other'}
                    className="peer sr-only" />
                  <div className={cn(
                    'flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs font-medium transition',
                    'border-border hover:bg-elevated peer-checked:border-brand/60 peer-checked:bg-brand/10 peer-checked:text-brand-text',
                  )}>
                    <cat.icon className="h-3.5 w-3.5" /> {cat.label}
                  </div>
                </label>
              ))}
            </div>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone">
            {(id) => <Input id={id} name="phone" type="tel" defaultValue={contact?.phone ?? ''} placeholder="+1 (555) 000-0000" />}
          </Field>
          <Field label="Alternate phone">
            {(id) => <Input id={id} name="phone_alt" type="tel" defaultValue={contact?.phone_alt ?? ''} placeholder="+1 (555) 000-0001" />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email">
            {(id) => <Input id={id} name="email" type="email" defaultValue={contact?.email ?? ''} placeholder="jane@example.com" />}
          </Field>
          <Field label="Organization">
            {(id) => <Input id={id} name="organization" defaultValue={contact?.organization ?? ''} placeholder="Riverside Elementary, Kaiser…" />}
          </Field>
        </div>

        <Field label="Specialty / Role">
          {(id) => <Input id={id} name="specialty" defaultValue={contact?.specialty ?? ''} placeholder="Pediatrician, Math teacher, Soccer coach…" />}
        </Field>

        <Field label="Address">
          {(id) => <Input id={id} name="address" defaultValue={contact?.address ?? ''} placeholder="123 Main St, Springfield, CA" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Birthday month">
            {(id) => (
              <select id={id} name="birthday_month" defaultValue={contact?.birthday_month ?? ''}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                <option value="">— month —</option>
                {['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Birthday day">
            {(id) => <Input id={id} name="birthday_day" type="number" min={1} max={31} defaultValue={contact?.birthday_day ?? ''} placeholder="Day" />}
          </Field>
        </div>

        <Field label="Notes">
          {(id) => <Textarea id={id} name="notes" defaultValue={contact?.notes ?? ''} placeholder="Insurance info, pickup person, special instructions…" className="min-h-[80px]" />}
        </Field>

        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 hover:bg-elevated/30 transition">
          <input type="checkbox" name="is_emergency" defaultChecked={contact?.is_emergency ?? false} className="h-4 w-4 accent-danger" />
          <div>
            <p className="text-sm font-medium">Emergency contact</p>
            <p className="text-xs text-muted">Appears in the emergency contacts strip</p>
          </div>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{contact ? 'Save Changes' : 'Add Contact'}</Button>
        </div>
      </form>
    </Modal>
  );
}
