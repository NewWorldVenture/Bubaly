/** Exact, deterministic matching over an already approved household projection. */
export type InboundEntityKind = 'school' | 'team' | 'contact' | 'provider';
export type InboundEntity = {
  key: string; id: string; label: string; kind: InboundEntityKind;
  aliases: string[]; senders: string[];
};
export type InboundEntityMatch = Pick<InboundEntity, 'key' | 'id' | 'label' | 'kind'> & {
  matchedBy: 'name' | 'alias' | 'sender';
};
export type InboundEntityResolution = { matches: InboundEntityMatch[]; ambiguousCount: number };

export function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

/** A single mailbox, optionally with a display name. Multiple senders never resolve. */
export function senderMailbox(value: string): string | null {
  const clean = value.trim();
  const wrapped = /^[^<>\r\n]*<([^<>]+)>$/.exec(clean);
  const match = /^([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)$/.exec(wrapped ? wrapped[1] : clean);
  return match ? match[1].toLowerCase() : null;
}

function mentioned(text: string, phrase: string): boolean {
  if (phrase.length < 3) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
}

export function resolveInboundEntities(
  input: { text: string; sender?: string | null }, candidates: readonly InboundEntity[],
): InboundEntityResolution {
  const text = normalizeEntityName(input.text);
  const sender = senderMailbox(input.sender ?? '');
  const hits = new Map<string, Map<string, { entity: InboundEntity; matchedBy: InboundEntityMatch['matchedBy'] }>>();
  const add = (term: string, entity: InboundEntity, matchedBy: InboundEntityMatch['matchedBy']) => {
    const entries = hits.get(term) ?? new Map();
    const old = entries.get(entity.key);
    if (!old || matchedBy === 'name') entries.set(entity.key, { entity, matchedBy });
    hits.set(term, entries);
  };
  for (const entity of candidates) {
    for (const [value, matchedBy] of [[entity.label, 'name'], ...entity.aliases.map((alias) => [alias, 'alias'])] as Array<[string, 'name' | 'alias']>) {
      const phrase = normalizeEntityName(value);
      if (mentioned(text, phrase)) add(`text:${phrase}`, entity, matchedBy);
    }
    if (sender && entity.senders.some((value) => senderMailbox(value) === sender)) add(`sender:${sender}`, entity, 'sender');
  }
  const matches = new Map<string, InboundEntityMatch>();
  let ambiguousCount = 0;
  for (const entries of hits.values()) {
    if (entries.size !== 1) { ambiguousCount++; continue; }
    const { entity, matchedBy } = entries.values().next().value!;
    const { key, id, label, kind } = entity;
    const old = matches.get(key);
    if (!old || matchedBy === 'name') matches.set(key, { key, id, label, kind, matchedBy });
  }
  return { matches: [...matches.values()].sort((a, b) => a.key.localeCompare(b.key)), ambiguousCount };
}
