import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const BOOTSTRAP = 'docs/audit/pg-bootstrap.sh';
const { load } = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): Workflow;
};

type Defaults = { run?: { 'working-directory'?: string } };
type Workflow = {
  on?: Record<string, { paths?: string[] } | null>;
  defaults?: Defaults;
  jobs?: Record<string, {
    defaults?: Defaults;
    steps?: { run?: string; 'working-directory'?: string }[];
  }>;
};

const executableLines = (source: string) => source.split('\n')
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

function repositoryPath(value: string): string {
  const path = posix.normalize(value);
  if (path !== value || path.startsWith('/') || path === '..'
    || path.startsWith('../') || /[$\\]/.test(path)) {
    throw new Error(`Expected a literal repository path: ${value}`);
  }
  return path;
}

/**
 * This guard understands the bootstrap's current literal psql -f and
 * for-file-loop grammar, not arbitrary Bash. A new ROOT-dependent command
 * shape must be reviewed instead of silently disappearing from the inputs.
 */
function bootstrapInputs(source: string): string[] {
  const lines = executableLines(source);
  const inputs = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\$(?:ROOT\b|\{ROOT\})/.test(line)) continue;
    if ((line.match(/\$(?:ROOT\b|\{ROOT\})/g)?.length ?? 0) > 1
      || (line.match(/(?:^|\s)-f(?:\s|$)/g)?.length ?? 0) > 1
      || /(?:^|\s)--file(?:=|\s|$)/.test(line)) {
      throw new Error(`Unsupported multiple bootstrap inputs: ${line}`);
    }
    const file = line.match(/^psql\b.*\s-f\s+(?:"\$ROOT"\/|"\$ROOT\/)([\w./*-]+)"?(?:\s|$)/);
    if (file) {
      inputs.add(repositoryPath(file[1]));
      continue;
    }
    const loop = line.match(/^for (\w+) in (?:"\$ROOT"\/|"\$ROOT\/)([\w./*-]+)"?; do(?:\s*#.*)?$/);
    if (loop) {
      const end = lines.indexOf('done', index + 1);
      const consumesFile = new RegExp(`^(?:if\\s+)?psql\\b.*\\s-f\\s+"\\$${loop[1]}"(?:\\s|$)`);
      if (end < 0 || !lines.slice(index + 1, end).some((body) => consumesFile.test(body)
        && (body.match(/(?:^|\s)-f(?:\s|$)/g)?.length ?? 0) === 1
        && !/(?:^|\s)--file(?:=|\s|$)/.test(body))) {
        throw new Error('Bootstrap file loop no longer feeds psql -f');
      }
      inputs.add(repositoryPath(loop[2]));
      continue;
    }
    throw new Error(`Unsupported bootstrap ROOT input: ${line}`);
  }
  return [...inputs].sort();
}

function invokesBootstrap(workflow: Workflow): boolean {
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      const directory = repositoryPath(step['working-directory']
        ?? job.defaults?.run?.['working-directory']
        ?? workflow.defaults?.run?.['working-directory'] ?? '.');
      for (const command of executableLines(step.run)) {
        const bash = command.match(/^bash\s+([\w./-]+)(?:\s|$)/);
        if (bash && repositoryPath(posix.join(directory, bash[1])) === BOOTSTRAP) return true;
      }
    }
  }
  return false;
}

function coversInput(input: string, paths: string[]): boolean {
  // These workflows use literal paths and trailing /** directory coverage.
  // Do not pretend to implement GitHub's ordered negative-pattern language.
  if (paths.some((path) => path.startsWith('!'))) {
    throw new Error('Negative workflow paths need explicit dependency review');
  }
  return paths.some((path) => path === input
    || (path.endsWith('/**') && input.startsWith(path.slice(0, -2))));
}

function missingInputs(workflow: Workflow, inputs: string[]) {
  if (!invokesBootstrap(workflow)) return [];
  return Object.entries(workflow.on ?? {}).flatMap(([event, trigger]) => (
    trigger?.paths
      ? inputs.filter((input) => !coversInput(input, trigger.paths!))
        .map((input) => ({ event, input }))
      : []
  ));
}

const bootstrapSource = readFileSync(join(ROOT, BOOTSTRAP), 'utf8');
const inputs = bootstrapInputs(bootstrapSource);
const callers = readdirSync(join(ROOT, '.github/workflows'))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, workflow: load(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')) }))
  .filter(({ workflow }) => invokesBootstrap(workflow));
const filteredEvents = callers.flatMap(({ file, workflow }) => (
  Object.entries(workflow.on ?? {}).flatMap(([event, trigger]) => (
    trigger?.paths ? [{ file, event, paths: trigger.paths }] : []
  ))
));

const fixture = (push: string[], pullRequest: string[]): Workflow => ({
  on: { push: { paths: push }, pull_request: { paths: pullRequest } },
  jobs: { database: { steps: [{ run: `bash ${BOOTSTRAP}` }] } },
});

describe('SQL runtime workflow filters cover the bootstrap they execute', () => {
  it('derives the actual seed and migration inputs from the bootstrap commands', () => {
    expect(inputs).toEqual(['supabase/SEED_ALL.sql', 'supabase/migrations/*.sql']);
  });

  it('finds all 32 filtered callers and both events, plus unfiltered main CI', () => {
    expect(callers).toHaveLength(33);
    expect(callers.map(({ file }) => file)).toContain('ci.yml');
    expect(new Set(filteredEvents.map(({ file }) => file)).size).toBe(32);
    expect(filteredEvents).toHaveLength(64);
    for (const { file } of callers.filter(({ file }) => file !== 'ci.yml')) {
      expect(filteredEvents.filter((entry) => entry.file === file).map(({ event }) => event).sort())
        .toEqual(['pull_request', 'push']);
    }
  });

  it.each(filteredEvents)('$file $event covers every bootstrap SQL input', ({ paths }) => {
    expect(inputs.filter((input) => !coversInput(input, paths)),
      'A change to this bootstrap input alone must run this event’s SQL gate').toEqual([]);
  });

  it('discovers an additional literal file instead of relying on the known seed filename', () => {
    expect(bootstrapInputs(`${bootstrapSource}\npsql -v ON_ERROR_STOP=1 -f "$ROOT/supabase/next_seed.sql"`))
      .toEqual(['supabase/SEED_ALL.sql', 'supabase/migrations/*.sql', 'supabase/next_seed.sql']);
  });

  it('does not treat commented commands as executable inputs', () => {
    expect(bootstrapInputs('# psql -f "$ROOT/supabase/comment.sql"\npsql -f "$ROOT/supabase/real.sql"'))
      .toEqual(['supabase/real.sql']);
  });

  it.each([
    ['dynamic input', 'psql -f "$ROOT/$SEED_FILE"', 'Unsupported bootstrap ROOT input'],
    ['escaping input', 'psql -f "$ROOT/../outside.sql"', 'Expected a literal repository path'],
    ['different command', 'cat "$ROOT/supabase/seed.sql"', 'Unsupported bootstrap ROOT input'],
    ['unused loop', 'for f in "$ROOT"/supabase/migrations/*.sql; do\necho "$f"\ndone', 'no longer feeds psql'],
    ['two ROOT file inputs', 'psql -f "$ROOT/supabase/extra.sql" -f "$ROOT/supabase/SEED_ALL.sql"', 'Unsupported multiple bootstrap inputs'],
    ['mixed literal and ROOT file inputs', 'psql -f supabase/extra.sql -f "$ROOT/supabase/SEED_ALL.sql"', 'Unsupported multiple bootstrap inputs'],
    ['extra long-option input', 'psql -f "$ROOT/supabase/SEED_ALL.sql" --file "$ROOT/supabase/extra.sql"', 'Unsupported multiple bootstrap inputs'],
    ['echo masquerading as a loop consumer', 'for f in "$ROOT"/supabase/migrations/*.sql; do\necho \'psql -f "$f"\'\ndone', 'no longer feeds psql'],
  ])('refuses an unreviewed %s', (_name, source, message) => {
    expect(() => bootstrapInputs(source)).toThrow(message);
  });

  it('does not borrow a seed entry from the other event or a sibling filename', () => {
    const workflow = fixture(['supabase/SEED_ALL.sql.bak'], ['supabase/SEED_ALL.sql']);
    expect(missingInputs(workflow, ['supabase/SEED_ALL.sql']))
      .toEqual([{ event: 'push', input: 'supabase/SEED_ALL.sql' }]);
  });

  it('accepts unfiltered events and a directory filter that actually includes the input', () => {
    const workflow = fixture(['supabase/**'], []);
    workflow.on!.pull_request = null;
    expect(missingInputs(workflow, inputs)).toEqual([]);
  });

  it('ignores a commented invocation and an unrelated working directory', () => {
    expect(invokesBootstrap({ jobs: { check: { steps: [{ run: `# bash ${BOOTSTRAP}` }] } } })).toBe(false);
    expect(invokesBootstrap({
      jobs: { check: { defaults: { run: { 'working-directory': 'mobile' } }, steps: [{ run: `bash ${BOOTSTRAP}` }] } },
    })).toBe(false);
  });

  it('refuses negative path rules rather than claiming a partial matcher proves coverage', () => {
    expect(() => coversInput('supabase/SEED_ALL.sql', ['supabase/**', '!supabase/SEED_ALL.sql']))
      .toThrow('Negative workflow paths');
  });
});
