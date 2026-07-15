import 'server-only';
import { fetchExternal } from '@/lib/server/external-fetch';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';

// Minimal GitHub Issues client for the feedback tracker. Key-gated: every call
// is a no-op unless GITHUB_TOKEN + GITHUB_FEEDBACK_REPO ("owner/repo") are set
// (owner-provisioned), so this whole integration ships dark and lights up when
// the owner adds a token — exactly like the other provider integrations.
//
// The "project tracker with two lists" is this repo's Issues, split by label
// (bug vs enhancement). A fine-grained PAT with Issues: read & write is enough.

const API = 'https://api.github.com';
const MAX_BODY = 1 << 20; // 1 MiB response cap

export function githubToken(): string {
  return process.env.GITHUB_TOKEN || process.env.GITHUB_FEEDBACK_TOKEN || '';
}
export function githubRepo(): string {
  return process.env.GITHUB_FEEDBACK_REPO || process.env.GITHUB_REPO || '';
}
export function isGithubConfigured(): boolean {
  return !!(githubToken() && /^[^/]+\/[^/]+$/.test(githubRepo()));
}

export type GithubIssue = {
  number: number;
  html_url: string;
  title: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  body: string | null;
  labels: string[];
  updated_at: string;
};

class GithubError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'GithubError'; }
}

async function gh<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchExternal(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bubaly-feedback-bot',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  }, 15_000);
  if (res.status === 204) return undefined as T;
  const bounded = await readBoundedResponseText(res, MAX_BODY);
  if (!bounded.ok) throw new GithubError(res.status, `GitHub ${path}: response too large`);
  if (!res.ok) throw new GithubError(res.status, `GitHub ${res.status} ${path}: ${bounded.text.slice(0, 300)}`);
  return bounded.text ? (JSON.parse(bounded.text) as T) : (undefined as T);
}

type RawIssue = {
  number: number; html_url: string; title: string; state: 'open' | 'closed';
  state_reason: string | null; body: string | null; updated_at: string;
  pull_request?: unknown; labels: Array<{ name: string } | string>;
};

function normalize(raw: RawIssue): GithubIssue {
  return {
    number: raw.number, html_url: raw.html_url, title: raw.title, state: raw.state,
    state_reason: raw.state_reason ?? null, body: raw.body ?? null, updated_at: raw.updated_at,
    labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
  };
}

/** Create an issue. Returns the new issue, or throws GithubError. */
export async function createIssue(input: { title: string; body: string; labels: string[] }): Promise<GithubIssue> {
  const raw = await gh<RawIssue>(`/repos/${githubRepo()}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
  });
  return normalize(raw);
}

/** A single issue by number. */
export async function getIssue(number: number): Promise<GithubIssue> {
  return normalize(await gh<RawIssue>(`/repos/${githubRepo()}/issues/${number}`));
}

/** Add a comment to an issue. */
export async function commentOnIssue(number: number, body: string): Promise<void> {
  await gh(`/repos/${githubRepo()}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

/**
 * List issues carrying the given labels, most-recently-updated first. Excludes
 * pull requests (the Issues API returns both). `since` filters by update time.
 */
export async function listIssuesByLabels(labels: string[], since?: string, perPage = 100): Promise<GithubIssue[]> {
  const params = new URLSearchParams({
    state: 'all', labels: labels.join(','), sort: 'updated', direction: 'desc',
    per_page: String(Math.min(perPage, 100)),
  });
  if (since) params.set('since', since);
  const raw = await gh<RawIssue[]>(`/repos/${githubRepo()}/issues?${params}`);
  return (raw ?? []).filter((r) => !r.pull_request).map(normalize);
}

/** Reopen/close an issue with a reason (used when status is pushed → GitHub). */
export async function setIssueState(number: number, state: 'open' | 'closed', stateReason?: 'completed' | 'not_planned'): Promise<void> {
  await gh(`/repos/${githubRepo()}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ state, ...(stateReason ? { state_reason: stateReason } : {}) }),
  });
}

/** Lightweight connectivity check for the admin console ("is GitHub wired?"). */
export async function githubRepoStatus(): Promise<{ ok: boolean; repo: string; detail: string }> {
  if (!isGithubConfigured()) return { ok: false, repo: githubRepo(), detail: 'GITHUB_TOKEN / GITHUB_FEEDBACK_REPO not set' };
  try {
    const res = await fetchExternal(`${API}/repos/${githubRepo()}`, {
      headers: { Authorization: `Bearer ${githubToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'bubaly-feedback-bot' },
    }, 10_000);
    if (!res.ok) { await readBoundedResponseJson(res, 4096).catch(() => ({})); return { ok: false, repo: githubRepo(), detail: `GitHub returned ${res.status}` }; }
    return { ok: true, repo: githubRepo(), detail: 'Connected' };
  } catch (e) {
    return { ok: false, repo: githubRepo(), detail: e instanceof Error ? e.message : 'Unreachable' };
  }
}
