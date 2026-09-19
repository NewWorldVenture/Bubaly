// `family-media` is PUBLIC and, until 0330, had no `allowed_mime_types` at all
// — the only one of the project's four public buckets without a list, and the
// one that takes the widest range of uploads (Photos, Moments, Inventory,
// Closet, Reminder attachments, Message attachments). Anything stored there is
// served from /storage/v1/object/public/… with no session, so an
// `image/svg+xml` or `text/html` upload is a page hosted on the project's own
// Supabase domain.
//
// That is NOT the same as F-E03. F-E03 ("the bucket is public") is tracked as
// LB-009 and deferred, because hardening reads to signed URLs needs a data
// migration of every stored URL. An allowlist constrains new uploads and needs
// no data migration — the expensive fix stayed parked and the cheap one was
// never taken.
//
// The risk in an allowlist is the opposite one: refusing something a family is
// entitled to upload. So the list is not invented — it is read off the `accept`
// attributes of the modules that upload here, and this test holds the two
// together in BOTH directions:
//
//   * every type a file picker offers must be allowed by the bucket, so adding
//     `.zip` to a picker fails here until the bucket is updated;
//   * the executable types must stay refused, whatever a picker later says.
//
// Audit C1-S8-10.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = 'supabase/migrations/0330_a_public_bucket_serves_what_you_put_in_it.sql';

function walk(...dirs: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  for (const d of dirs) visit(d);
  return out;
}

/** The allowlist 0330 writes, read out of the migration rather than restated. */
function allowedTypes(): string[] {
  const sql = readFileSync(path.join(ROOT, MIGRATION), 'utf8');
  const body = sql.slice(sql.indexOf('set allowed_mime_types'), sql.indexOf('where id ='));
  return [...body.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((m) => m[1]);
}

/** Files that upload to the public `family-media` bucket. */
function uploaders(): string[] {
  return walk('components', 'app')
    .filter((rel) => rel.endsWith('.tsx'))
    .filter((rel) => /storage\s*\n?\s*\.?from\(['"`]family-media['"`]\)[\s\S]{0,120}?\.upload\(/.test(
      readFileSync(path.join(ROOT, rel), 'utf8'),
    ));
}

/** Every `accept=` token in a file, normalised to MIME types. */
const EXTENSION_TYPES: Record<string, string> = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

function acceptedTypes(rel: string): string[] {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/accept="([^"]+)"/g)) {
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (raw.startsWith('.')) {
        // An extension the browser maps to a type. An unknown one is a real
        // gap, not something to skip quietly.
        const mapped = EXTENSION_TYPES[raw.toLowerCase()];
        out.push(mapped ?? `UNMAPPED_EXTENSION(${raw})`);
      } else out.push(raw);
    }
  }
  return out;
}

describe('the public family-media bucket allows only what the UI offers', () => {
  const allowed = allowedTypes();

  it('reads a real allowlist out of the migration', () => {
    // A parse that quietly returned [] would make everything below vacuous.
    // The floor is deliberately well below the real count: a tight one would
    // catch a dropped type here, in a test about PARSING, and mask the coverage
    // assertion that is supposed to catch it.
    expect(allowed.length).toBeGreaterThanOrEqual(8);
    expect(allowed).toContain('image/jpeg');
    expect(allowed).toContain('application/pdf');
  });

  it('finds the uploaders it is about', () => {
    const found = uploaders();
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found).toContain('components/modules/photos-module.tsx');
    expect(found).toContain('components/modules/messages-module.tsx');
  });

  it('never allows a type a browser executes', () => {
    // The whole point of the migration. These stay refused whatever a picker
    // later says, so this assertion comes before the coverage one below.
    for (const dangerous of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']) {
      expect(allowed, `${dangerous} is served executable from a public URL`).not.toContain(dangerous);
    }
  });

  it('covers every concrete type the pickers offer', () => {
    const missing: string[] = [];
    for (const rel of uploaders()) {
      for (const type of acceptedTypes(rel)) {
        if (type.endsWith('/*')) {
          // A wildcard is a family, not a type: require at least one member of
          // it, which is what keeps `video/*` from being silently unsupported.
          const family = type.slice(0, -1);
          if (!allowed.some((a) => a.startsWith(family))) missing.push(`${rel}: ${type}`);
          continue;
        }
        if (!allowed.includes(type)) missing.push(`${rel}: ${type}`);
      }
    }
    expect(missing, 'a file picker offers a type the bucket will refuse').toEqual([]);
  });

  it('keeps the other three public buckets restricted too', () => {
    // family-media was the only one without a list; this is the statement that
    // it was an outlier rather than the convention.
    const listed = ['supabase/migrations/00890_avatars_bucket.sql',
      'supabase/migrations/0194_marketplace_photos_bucket.sql',
      'supabase/migrations/0197_feedback_ideas.sql'];
    for (const rel of listed) {
      const sql = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(sql.toLowerCase(), `${rel} no longer pins allowed_mime_types`).toContain('allowed_mime_types');
    }
  });
});
