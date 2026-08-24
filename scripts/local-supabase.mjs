import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const productionProjectRef = 'cyjpucvvekzfpvvonuld';
const localProjectId = 'attendance-local';
const baselineFileName = '00000000000000_shared_schema_test_baseline.sql';
const cliCommands = new Set(['prepare', 'start', 'reset', 'test', 'verify', 'stop']);
const databaseContainer = `supabase_db_${localProjectId}`;

// The SQL suites, in the order they run. Adding one is a line here and a file
// in supabase/tests/sql; nothing else has to know about it.
const sqlSuites = [
  'punch_engine_test.sql',
  'alert_engine_test.sql',
  'read_api_test.sql',
  'security_invariants_test.sql',
];
const usage =
  'Usage: node scripts/local-supabase.mjs <prepare|start|reset|test|verify|stop>';

export const defaultLocalWorkdir = path.join(defaultRepositoryRoot, '.local', 'supabase');

export function parseCliCommand(arguments_) {
  if (arguments_.length !== 1 || !cliCommands.has(arguments_[0])) {
    throw new Error(usage);
  }
  return arguments_[0];
}

export function buildSupabaseArguments(command, { workdir = defaultLocalWorkdir } = {}) {
  const resolvedWorkdir = path.resolve(workdir);
  const prefix = ['--workdir', resolvedWorkdir];
  const commands = {
    start: [...prefix, 'db', 'start'],
    reset: [...prefix, 'db', 'reset', '--local'],
    stop: [...prefix, 'stop', '--project-id', localProjectId],
  };

  const arguments_ = commands[command];
  if (!arguments_) {
    throw new Error(`Unsupported local Supabase command: ${command}`);
  }
  return arguments_;
}

// The suites do not go through `supabase db query`. That command sends the file
// as one prepared statement, and Postgres refuses a prepared statement holding
// more than one command -- which every suite is by construction: a transaction,
// the checks, a report and a rollback. psql inside the database container reads
// the whole file, honours BEGIN/ROLLBACK and stops at the first error.
//
// It is also the narrowest target available. There is no connection string here
// to point somewhere else by accident: the only thing named is a container that
// this repository's own workflow started, on this machine.
export function buildDatabaseShellArguments() {
  return [
    'exec',
    '--interactive',
    '--env',
    'PGCLIENTENCODING=UTF8',
    databaseContainer,
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'postgres',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
  ];
}

export async function runSqlSuite(
  suiteFile,
  { workdir = defaultLocalWorkdir, spawnProcess = spawnSync } = {},
) {
  const suitePath = path.join(path.resolve(workdir), 'supabase', 'tests', 'sql', suiteFile);
  const sql = await readFile(suitePath, 'utf8');
  const result = spawnProcess('docker', buildDatabaseShellArguments(), {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `SQL suite ${suiteFile} failed in container ${databaseContainer} ` +
        `(exit status ${result.status}).`,
    );
  }
}

function localConfig(source) {
  const projectPattern = /^project_id\s*=\s*"[^"]+"\s*$/m;
  if (!projectPattern.test(source)) {
    throw new Error('supabase/config.toml does not declare project_id');
  }

  const config = source.replace(projectPattern, `project_id = "${localProjectId}"`);
  if (config.includes(productionProjectRef)) {
    throw new Error('Generated local config still contains the production project reference');
  }

  return `${config.trimEnd()}\n\n[db.seed]\nenabled = true\nsql_paths = ["./seed.sql"]\n`;
}

export async function prepareWorkspace({
  repositoryRoot = defaultRepositoryRoot,
  workdir = defaultLocalWorkdir,
} = {}) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const resolvedWorkdir = path.resolve(workdir);
  const sourceSupabase = path.join(resolvedRepositoryRoot, 'supabase');
  const generatedSupabase = path.join(resolvedWorkdir, 'supabase');
  const generatedMigrations = path.join(generatedSupabase, 'migrations');
  const sourceMigrations = path.join(sourceSupabase, 'migrations');
  const fixtures = path.join(sourceSupabase, 'tests', 'fixtures');

  if (resolvedWorkdir === resolvedRepositoryRoot) {
    throw new Error('The generated local workspace cannot replace the repository root');
  }

  await rm(resolvedWorkdir, { recursive: true, force: true });
  await mkdir(generatedMigrations, { recursive: true });

  const sourceConfig = await readFile(path.join(sourceSupabase, 'config.toml'), 'utf8');
  await writeFile(path.join(generatedSupabase, 'config.toml'), localConfig(sourceConfig));

  await copyFile(
    path.join(fixtures, 'shared_schema_test_baseline.sql'),
    path.join(generatedMigrations, baselineFileName),
  );

  const migrationFiles = (await readdir(sourceMigrations))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const migrationFile of migrationFiles) {
    await copyFile(
      path.join(sourceMigrations, migrationFile),
      path.join(generatedMigrations, migrationFile),
    );
  }

  await copyFile(path.join(fixtures, 'local_seed.sql'), path.join(generatedSupabase, 'seed.sql'));
  await cp(
    path.join(sourceSupabase, 'tests', 'sql'),
    path.join(generatedSupabase, 'tests', 'sql'),
    { recursive: true },
  );

  return {
    workdir: resolvedWorkdir,
    migrationCount: migrationFiles.length + 1,
  };
}

export async function runSupabaseCli(arguments_) {
  const cliEntrypoint = path.join(
    defaultRepositoryRoot,
    'node_modules',
    'supabase',
    'dist',
    'supabase.js',
  );
  const result = spawnSync(process.execPath, [cliEntrypoint, ...arguments_], {
    cwd: defaultRepositoryRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('Node.js or the Supabase CLI is missing. Run npm install first.');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Supabase CLI exited with status ${result.status}`);
  }
}

export function assertDockerAvailable({ spawnProcess = spawnSync } = {}) {
  const result = spawnProcess(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (!result.error && result.status === 0) {
    return;
  }

  const detail = result.error?.message ?? result.stderr?.trim();
  const suffix = detail ? ` Details: ${detail}` : '';
  throw new Error(
    'Docker Desktop with a running daemon is required for the disposable local database. ' +
      `No remote fallback is allowed.${suffix}`,
  );
}

export async function executeLocalCommand(
  command,
  {
    repositoryRoot = defaultRepositoryRoot,
    workdir = defaultLocalWorkdir,
    runSupabase = runSupabaseCli,
    runSuite = runSqlSuite,
    assertDocker = assertDockerAvailable,
  } = {},
) {
  if (!cliCommands.has(command)) {
    throw new Error(`Unsupported local Supabase command: ${command}`);
  }

  if (command === 'stop') {
    await runSupabase(buildSupabaseArguments('stop', { workdir }));
    return;
  }

  const prepared = await prepareWorkspace({ repositoryRoot, workdir });
  if (command === 'prepare') {
    return prepared;
  }

  await assertDocker();

  const commandSequence = {
    start: ['start'],
    reset: ['reset'],
    test: [],
    verify: ['start', 'reset'],
  }[command];

  for (const localCommand of commandSequence) {
    await runSupabase(buildSupabaseArguments(localCommand, { workdir }));
  }

  if (command === 'test' || command === 'verify') {
    for (const suiteFile of sqlSuites) {
      await runSuite(suiteFile, { workdir });
    }
  }

  return prepared;
}

async function main() {
  const command = parseCliCommand(process.argv.slice(2));
  const result = await executeLocalCommand(command);
  if (result) {
    console.log(`Prepared isolated Supabase workspace at ${result.workdir}`);
    console.log(`Migration files: ${result.migrationCount}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
