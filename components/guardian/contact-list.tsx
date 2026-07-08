'use client';

import { useState } from 'react';
import { Plus, Search, Pencil, Trash2, Phone, Mail, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
  TRUST_LEVELS, TRUST_LABELS, TRUST_COLORS, TRUST_BG_COLORS, TRUST_ICONS,
  type TrustLevel,
} from '@/lib/guardian/trust';
import { upsertContactAction, deleteContactAction, updateContactTrustAction } from '@/app/(app)/guardian/actions';
import { useToast } from '@/components/ui/toast';
import { formatPhone } from '@/lib/guardian/phone';

type Contact = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  trust_level: TrustLevel;
  trust_override: boolean;
  notes: string | null;
  total_calls: number;
  total_sms: number;
  last_contact_at: string | null;
  spam_score: number;
};

type Member = { id: string; display_name: string };

export function ContactList({ contacts: initial, members }: { contacts: Contact[]; members: Member[] }) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [contacts, setContacts] = useState(initial);
  const [search, setSearch] = useState('');
  const [filterTrust, setFilterTrust] = useState<TrustLevel | 'all'>('all');
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  const filtered = contacts.filter((c) => {
    const q = search.toLowerCase();
    if (q && !c.name?.toLowerCase().includes(q) && !c.phone?.includes(q) && !c.email?.toLowerCase().includes(q)) return false;
    if (filterTrust !== 'all' && c.trust_level !== filterTrust) return false;
    return true;
  });

  // Group by trust level
  const grouped = TRUST_LEVELS.reduce<Record<TrustLevel, Contact[]>>((acc, lvl) => {
    acc[lvl] = filtered.filter((c) => c.trust_level === lvl);
    return acc;
  }, {} as Record<TrustLevel, Contact[]>);

  async function handleSave(form: {
    name: string; phone: string; email: string; notes: string; trust_level: TrustLevel; member_id: string;
  }) {
    setSaving(true);
    const res = await upsertContactAction({
      id: editing !== 'new' && editing ? editing.id : undefined,
      name: form.name,
      phone: form.phone,
      email: form.email,
      notes: form.notes,
      trust_level: form.trust_level,
      member_id: form.member_id || undefined,
    });
    setSaving(false);
    if (!res.ok) { toastError(res.error); return; }
    toastSuccess(editing === 'new' ? 'Contact added' : 'Contact updated');
    setEditing(null);
    // Refresh happens via server revalidation; optimistically update local state
    if (editing === 'new' && res.data) {
      setContacts(prev => [...prev, {
        id: res.data!.id,
        name: form.name,
        phone: form.phone || null,
        email: form.email || null,
        trust_level: form.trust_level,
        trust_override: true,
        notes: form.notes || null,
        total_calls: 0,
        total_sms: 0,
        last_contact_at: null,
        spam_score: 0,
      }]);
    } else if (editing && editing !== 'new') {
      setContacts(prev => prev.map(c => c.id === editing.id ? { ...c, ...form } : c));
    }
  }

  async function handleDelete(id: string) {
    const res = await deleteContactAction(id);
    if (!res.ok) { toastError(res.error); return; }
    toastSuccess('Contact removed');
    setContacts(prev => prev.filter(c => c.id !== id));
  }

  async function handleTrustChange(id: string, trust: TrustLevel) {
    const res = await updateContactTrustAction(id, trust);
    if (!res.ok) { toastError(res.error); return; }
    setContacts(prev => prev.map(c => c.id === id ? { ...c, trust_level: trust, trust_override: true } : c));
    toastSuccess('Trust updated');
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contacts…"
            className="h-10 w-full rounded-xl border border-border bg-bg pl-9 pr-3 text-sm"
          />
        </div>
        <select
          value={filterTrust}
          onChange={(e) => setFilterTrust(e.target.value as TrustLevel | 'all')}
          className="h-10 rounded-xl border border-border bg-bg px-3 text-sm"
        >
          <option value="all">All trust levels</option>
          {TRUST_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>{TRUST_ICONS[lvl]} {TRUST_LABELS[lvl]}</option>
          ))}
        </select>
        <button
          onClick={() => setEditing('new')}
          className="flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90 transition shrink-0"
        >
          <Plus className="h-4 w-4" /> Add Contact
        </button>
      </div>

      {/* Groups */}
      {TRUST_LEVELS.map((lvl) => {
        const group = filterTrust === 'all' ? grouped[lvl] : (lvl === filterTrust ? filtered : []);
        if (!group.length) return null;
        return (
          <div key={lvl} className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
            <div className={cn('flex items-center gap-2 border-b border-border px-4 py-2.5', TRUST_BG_COLORS[lvl])}>
              <span className="text-base">{TRUST_ICONS[lvl]}</span>
              <span className={cn('text-sm font-semibold', TRUST_COLORS[lvl])}>{TRUST_LABELS[lvl]}</span>
              <span className="ml-auto text-xs text-muted">{group.length}</span>
            </div>
            <div className="divide-y divide-border">
              {group.map((c) => (
                <ContactRow
                  key={c.id}
                  contact={c}
                  onEdit={() => setEditing(c)}
                  onDelete={() => handleDelete(c.id)}
                  onTrustChange={(t) => handleTrustChange(c.id, t)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {filtered.length === 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 py-10 text-center text-sm text-muted">
          No contacts found.{' '}
          <button className="text-brand underline" onClick={() => setEditing('new')}>Add one</button>.
        </div>
      )}

      {/* Edit / Create modal */}
      {editing && (
        <ContactModal
          contact={editing === 'new' ? null : editing}
          members={members}
          saving={saving}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ContactRow({
  contact: c,
  onEdit,
  onDelete,
  onTrustChange,
}: {
  contact: Contact;
  onEdit: () => void;
  onDelete: () => void;
  onTrustChange: (t: TrustLevel) => void;
}) {
  const [showTrustPicker, setShowTrustPicker] = useState(false);

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-surface/60 transition">
      {/* Avatar */}
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elevated text-sm font-bold">
        {c.name ? c.name[0]?.toUpperCase() : '?'}
      </div>
      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{c.name ?? 'Unknown'}</p>
        <div className="flex gap-2 mt-0.5">
          {c.phone && <span className="text-xs text-muted flex items-center gap-1"><Phone className="h-3 w-3" />{formatPhone(c.phone)}</span>}
          {c.email && <span className="text-xs text-muted flex items-center gap-1"><Mail className="h-3 w-3" />{c.email}</span>}
        </div>
      </div>
      {/* Stats */}
      <div className="hidden sm:flex items-center gap-3 text-xs text-muted">
        <span>{c.total_calls} calls</span>
        <span>{c.total_sms} texts</span>
      </div>
      {/* Trust picker */}
      <div className="relative">
        <button
          onClick={() => setShowTrustPicker(!showTrustPicker)}
          className={cn('flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition', TRUST_BG_COLORS[c.trust_level], TRUST_COLORS[c.trust_level])}
        >
          {TRUST_ICONS[c.trust_level]} {TRUST_LABELS[c.trust_level]}
          <ChevronDown className="h-3 w-3" />
        </button>
        {showTrustPicker && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowTrustPicker(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 min-w-[180px] rounded-xl border border-border bg-bg shadow-xl py-1">
              {TRUST_LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => { onTrustChange(lvl); setShowTrustPicker(false); }}
                  className={cn('flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-surface transition', c.trust_level === lvl && 'bg-brand/10')}
                >
                  <span>{TRUST_ICONS[lvl]}</span>
                  <span className={TRUST_COLORS[lvl]}>{TRUST_LABELS[lvl]}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {/* Actions */}
      <button onClick={onEdit} className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg transition"><Pencil className="h-4 w-4" /></button>
      <button onClick={onDelete} className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400 transition"><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

function ContactModal({
  contact,
  members,
  saving,
  onSave,
  onClose,
}: {
  contact: Contact | null;
  members: Member[];
  saving: boolean;
  onSave: (form: { name: string; phone: string; email: string; notes: string; trust_level: TrustLevel; member_id: string }) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: contact?.name ?? '',
    phone: contact?.phone ?? '',
    email: contact?.email ?? '',
    notes: contact?.notes ?? '',
    trust_level: (contact?.trust_level ?? 'known_contact') as TrustLevel,
    member_id: '',
  });

  function set(k: keyof typeof form, v: string) { setForm(p => ({ ...p, [k]: v })); }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-bg p-5 space-y-4 shadow-2xl">
        <h2 className="text-lg font-bold">{contact ? 'Edit Contact' : 'Add Contact'}</h2>
        <div className="space-y-3">
          <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Name *" className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm" />
          <input value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="Phone (e.g. +15551234567)" className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm" />
          <input value={form.email} onChange={e => set('email', e.target.value)} placeholder="Email (optional)" className="h-10 w-full rounded-lg border border-border bg-elevated px-3 text-sm" />
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">Trust Level</label>
            <div className="grid grid-cols-2 gap-1.5">
              {TRUST_LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => set('trust_level', lvl)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition',
                    form.trust_level === lvl ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:border-brand/40',
                  )}
                >
                  {TRUST_ICONS[lvl]} {TRUST_LABELS[lvl]}
                </button>
              ))}
            </div>
          </div>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Notes (optional)" className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm min-h-[60px]" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium hover:bg-surface transition">Cancel</button>
          <button
            onClick={() => { if (form.name.trim()) onSave(form); }}
            disabled={saving || !form.name.trim()}
            className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50 transition"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
