import 'server-only';
import { DEFAULT_AI_SETTINGS } from '@/lib/ai/family-settings';
import { isSensitiveMemory } from '@/lib/services/memory';
import { fail, ok, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { readAllPages } from '@/lib/supabase/read-all-pages';
import { normalizeEntityName, resolveInboundEntities, senderMailbox, type InboundEntity, type InboundEntityKind, type InboundEntityResolution } from './resolve';

type GraphRow = { id: string; name: string; kind: string; ref_table: string | null; ref_id: string | null; attributes: unknown };
type FactRow = { id: string; label: string; value: string; category: string; source: string; expires_at: string | null };
const MANUAL_KINDS: Record<string, InboundEntityKind> = { school: 'school', team: 'team', contact: 'contact', sender: 'contact', company: 'provider', service_provider: 'provider' };
const PRIVATE_NAME = /\b(doctor|dr\.?|clinic|hospital|medical|dental|dentist|therapy|therapist|psychiatr|bank|insurance|financial|account|pediatric|pharmacy)\b/i;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length >= 3 && v.length <= 200).map((v) => v.trim()) : [];
const safeName = (label: string) => label.length >= 3 && label.length <= 200 && !PRIVATE_NAME.test(label) && !isSensitiveMemory({ key: label, content: '' });

/** Only explicit manual metadata or safe, known projector sources establish identity. */
function graphCandidate(row: GraphRow): InboundEntity | null {
  const attributes = object(row.attributes);
  const provenance = object(attributes.provenance);
  let kind: InboundEntityKind | undefined;
  if (provenance.source === 'projection' && provenance.ref_table === row.ref_table) {
    if (row.ref_table === 'school_classes' && row.kind === 'org') kind = 'school';
    if (row.ref_table === 'teams' && row.kind === 'activity') kind = 'team';
  } else if (provenance.source === 'manual' && row.ref_table === null) {
    kind = MANUAL_KINDS[String(attributes.node_type ?? '').toLowerCase()];
  }
  if (!kind || !safeName(row.name)) return null;
  return {
    key: `graph_entities:${row.id}`, id: row.id, label: row.name, kind,
    // Projected attributes cannot confirm an alias. Manual ones are explicit
    // saved entries, never a guess based on a sender's domain or name prefix.
    aliases: provenance.source === 'manual' ? strings(attributes.aliases).filter(safeName) : [],
    senders: provenance.source === 'manual' ? strings(attributes.senders).filter((s) => senderMailbox(s) !== null) : [],
  };
}

/** Confirmed Contacts use their label as identity and a single mailbox as sender.
 * An explicit "Alias for <canonical label>" contact supplies one name alias.
 * Free-form notes/values never become inferred aliases. */
function addConfirmedContacts(candidates: InboundEntity[], facts: FactRow[], now: Date): void {
  const eligible = facts.filter((fact) => {
    if (!['user', 'import', 'ai_inferred', 'ai_conversation'].includes(fact.source)) return false;
    if (fact.expires_at && (!Number.isFinite(Date.parse(fact.expires_at)) || Date.parse(fact.expires_at) <= now.getTime())) return false;
    return !isSensitiveMemory({ category: fact.category, key: fact.label, content: fact.value }) && !PRIVATE_NAME.test(`${fact.label} ${fact.value}`);
  });
  // Establish all canonical contacts before applying aliases, so ID/page order
  // cannot decide whether a confirmed alias exists.
  for (const fact of [...eligible.filter((f) => !/^alias for\s+/i.test(f.label.trim())), ...eligible.filter((f) => /^alias for\s+/i.test(f.label.trim()))]) {
    const aliasFor = /^alias for\s+(.+)$/i.exec(fact.label.trim());
    const label = aliasFor?.[1] ?? fact.label;
    if (!safeName(label)) continue;
    const targets = candidates.filter((candidate) => normalizeEntityName(candidate.label) === normalizeEntityName(label) && (aliasFor || candidate.key.startsWith('graph_entities:')));
    const mailbox = senderMailbox(fact.value);
    if (aliasFor) {
      if (targets.length === 1 && safeName(fact.value) && !mailbox && !/[\r\n;]|https?:/i.test(fact.value)) targets[0].aliases.push(fact.value.trim());
      continue;
    }
    if (!mailbox) continue;
    if (targets.length > 0) {
      // A duplicate canonical name retains the same sender on both candidates;
      // the resolver will leave that sender ambiguous instead of picking one.
      for (const target of targets) target.senders.push(mailbox);
    } else {
      candidates.push({ key: `family_facts:${fact.id}`, id: fact.id, label, kind: 'contact', aliases: [], senders: [mailbox] });
    }
  }
}

export async function resolveInboundEntityContext(
  scope: ServiceScope, input: { text: string; sender?: string | null },
): Promise<ServiceResult<InboundEntityResolution>> {
  try {
    const settings = await scope.db.from('family_ai_settings').select('memory_enabled').eq('family_id', scope.familyId).maybeSingle();
    if (settings.error) throw settings.error;
    const memoryEnabled = settings.data?.memory_enabled ?? DEFAULT_AI_SETTINGS.memoryEnabled;
    const columns = 'id,name,kind,ref_table,ref_id,attributes';
    const results = await Promise.all([
      readAllPages((from, to) => scope.db.from('graph_entities').select(columns).eq('family_id', scope.familyId)
        .in('ref_table', ['school_classes', 'teams']).order('id').range(from, to)),
      readAllPages((from, to) => scope.db.from('graph_entities').select(columns).eq('family_id', scope.familyId)
        .is('ref_table', null).eq('attributes->provenance->>source', 'manual').order('id').range(from, to)),
      memoryEnabled ? readAllPages((from, to) => scope.db.from('family_facts').select('id,label,value,category,source,expires_at')
        .eq('family_id', scope.familyId).eq('category', 'contact').order('id').range(from, to)) : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of results) if (result.error || result.data === null) throw result.error ?? new Error('Entity data was unavailable');
    const candidates = [...results[0].data!, ...results[1].data!].map((row) => graphCandidate(row as GraphRow)).filter((row): row is InboundEntity => row !== null);
    if (memoryEnabled) addConfirmedContacts(candidates, results[2].data as FactRow[], scope.now ?? new Date());
    return ok(resolveInboundEntities(input, candidates));
  } catch (error) {
    console.error('[inbound-entities] household entity read failed', error);
    return fail('Could not match the saved household contacts. Retry.', { retryable: true });
  }
}
