import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and an anon key are required.');
  process.exit(1);
}

const request = async (key, resource) => {
  try {
    const response = await fetch(`${url}/rest/v1/${resource}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  } catch (error) {
    return { response: null, body: null, error };
  }
};

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
};

const servicePages = await request(
  serviceKey,
  'marketing_pages?select=path,status,deleted_at&order=created_at.asc&limit=5000',
);
if (!servicePages.response?.ok || !Array.isArray(servicePages.body)) {
  fail(`service-role marketing_pages probe failed (HTTP ${servicePages.response?.status || 'network'}).`);
} else {
  console.log(`OK      service-role page inventory (${servicePages.body.length} rows visible).`);
}

const publicPublished = await request(
  anonKey,
  'marketing_pages?select=path,status,deleted_at&status=eq.published&deleted_at=is.null&limit=1000',
);
if (!publicPublished.response?.ok || !Array.isArray(publicPublished.body)) {
  fail(`anonymous published-page probe failed (HTTP ${publicPublished.response?.status || 'network'}).`);
} else if (publicPublished.body.some((page) => page.status !== 'published' || page.deleted_at !== null)) {
  fail('anonymous published-page probe returned a draft, non-published, or deleted row.');
} else {
  console.log(`OK      anonymous published-only read (${publicPublished.body.length} rows).`);
}

const publicDrafts = await request(
  anonKey,
  'marketing_pages?select=path,status,deleted_at&status=neq.published&limit=1',
);
if (!publicDrafts.response?.ok || !Array.isArray(publicDrafts.body)) {
  fail(`anonymous draft-isolation probe failed (HTTP ${publicDrafts.response?.status || 'network'}).`);
} else if (publicDrafts.body.length > 0) {
  fail('anonymous draft-isolation probe returned non-published marketing content.');
} else {
  console.log('OK      anonymous draft isolation.');
}

const publicDeleted = await request(
  anonKey,
  'marketing_pages?select=path,status,deleted_at&deleted_at=not.is.null&limit=1',
);
if (!publicDeleted.response?.ok || !Array.isArray(publicDeleted.body)) {
  fail(`anonymous deleted-page probe failed (HTTP ${publicDeleted.response?.status || 'network'}).`);
} else if (publicDeleted.body.length > 0) {
  fail('anonymous deleted-page probe returned soft-deleted marketing content.');
} else {
  console.log('OK      anonymous deleted-page isolation.');
}

const privateTables = [
  ['marketing_page_versions', 'id'],
  ['marketing_content_templates', 'id'],
  ['marketing_brand_rules', 'id'],
  ['marketing_generation_jobs', 'id'],
  ['marketing_embeddings', 'id'],
  ['marketing_provider_observations', 'id'],
  ['marketing_provider_syncs', 'provider'],
];
for (const [table, keyColumn] of privateTables) {
  const result = await request(anonKey, `${table}?select=${keyColumn}&limit=1`);
  const isHidden = result.response && [401, 403, 404].includes(result.response.status);
  if (!result.response || (!result.response.ok && !isHidden)) {
    fail(`anonymous private-table probe failed for ${table} (HTTP ${result.response?.status || 'network'}).`);
  } else if (result.response.ok && Array.isArray(result.body) && result.body.length > 0) {
    fail(`anonymous private-table probe returned rows from ${table}.`);
  } else {
    console.log(`OK      anonymous private isolation (${table}).`);
  }
}

if (process.exitCode) {
  console.error('\nMarketing public access verification failed.');
  process.exit(1);
}

console.log('\nMarketing public access verification passed.');
