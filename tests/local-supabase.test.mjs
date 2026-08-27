import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertDockerAvailable,
  buildDatabaseShellArguments,
  buildSupabaseArguments,
  executeLocalCommand,
  parseCliCommand,
  prepareWorkspace,
  runSqlSuite,
  runSupabaseCli,
} from '../scripts/local-supabase.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionProjectRef = 'cyjpucvvekzfpvvonuld';

test('prepareWorkspace creates an isolated local Supabase project', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'attendance-local-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const workdir = path.join(temporaryRoot, 'workspace');
  const result = await prepareWorkspace({ repositoryRoot, workdir });
  const generatedSupabase = path.join(workdir, 'supabase');
  const config = await readFile(path.join(generatedSupabase, 'config.toml'), 'utf8');
  const migrations = (await readdir(path.join(generatedSupabase, 'migrations'))).sort();

  assert.equal(result.workdir, workdir);
  assert.match(config, /^project_id = "attendance-local"$/m);
  assert.doesNotMatch(config, new RegExp(productionProjectRef));
  assert.equal(migrations[0], '00000000000000_shared_schema_test_baseline.sql');
  assert.equal(migrations.length, 20);
  assert.ok(migrations.includes('20260824172955_free_plan_maintenance.sql'));
  assert.ok(migrations.includes('20260825153106_alert_evaluation_and_outbox.sql'));
  assert.ok(migrations.includes('20260825153406_attendance_read_api.sql'));
  assert.ok(migrations.includes('20260826201929_attendance_review_api.sql'));
  assert.ok(migrations.includes('20260826202237_attendance_admin_api.sql'));
  assert.ok(migrations.includes('20260827144253_attendance_sessions_and_stats.sql'));
  assert.ok(migrations.includes('20260827162327_attendance_workforce_api.sql'));
  assert.ok(migrations.includes('20260827185038_attendance_reports_api.sql'));
  assert.ok(migrations.includes('20260827190500_report_population_and_expected_seconds.sql'));
  assert.equal(
    await readFile(path.join(generatedSupabase, 'seed.sql'), 'utf8'),
    await readFile(path.join(repositoryRoot, 'supabase/tests/fixtures/local_seed.sql'), 'utf8'),
  );
  assert.equal(
    await readFile(path.join(generatedSupabase, 'tests/sql/punch_engine_test.sql'), 'utf8'),
    await readFile(path.join(repositoryRoot, 'supabase/tests/sql/punch_engine_test.sql'), 'utf8'),
  );
});

test('buildSupabaseArguments permits only local database operations', () => {
  const workdir = path.join(repositoryRoot, '.local', 'supabase');
  const expected = {
    start: ['--workdir', workdir, 'db', 'start'],
    reset: ['--workdir', workdir, 'db', 'reset', '--local'],
    stop: ['--workdir', workdir, 'stop', '--project-id', 'attendance-local'],
  };

  for (const [command, expectedArguments] of Object.entries(expected)) {
    const arguments_ = buildSupabaseArguments(command, { workdir });
    assert.deepEqual(arguments_, expectedArguments);
    assert.ok(!arguments_.includes('--linked'));
    assert.ok(!arguments_.includes('--db-url'));
    assert.ok(!arguments_.includes(productionProjectRef));
  }

  assert.throws(
    () => buildSupabaseArguments('push', { workdir }),
    /Unsupported local Supabase command: push/,
  );

  // The suites are not a Supabase CLI command any more. `db query` sends a file
  // as one prepared statement and Postgres rejects a prepared statement holding
  // several commands, so that path never ran a suite at all.
  assert.throws(
    () => buildSupabaseArguments('engine-test', { workdir }),
    /Unsupported local Supabase command: engine-test/,
  );
});

test('buildDatabaseShellArguments reaches only this repository local container', () => {
  const arguments_ = buildDatabaseShellArguments();

  assert.deepEqual(arguments_, [
    'exec',
    '--interactive',
    '--env',
    'PGCLIENTENCODING=UTF8',
    'supabase_db_attendance-local',
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'postgres',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
  ]);

  // A container name cannot be pointed at a remote database. There is nothing
  // here shaped like a connection string, a host or a project reference.
  for (const argument of arguments_) {
    assert.doesNotMatch(argument, /postgres(ql)?:\/\//);
    assert.doesNotMatch(argument, /--db-url|--linked|--host|--port/);
    assert.doesNotMatch(argument, new RegExp(productionProjectRef));
    assert.doesNotMatch(argument, /supabase\.co|supabase\.com/);
  }

  // Without this a failing check would be reported and the suite would still
  // exit zero, which is how a green build hides a red test.
  assert.ok(arguments_.includes('ON_ERROR_STOP=1'));
});

test('runSqlSuite pipes the suite and fails loudly on a non-zero exit', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'attendance-suite-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const workdir = path.join(temporaryRoot, 'workspace');
  await prepareWorkspace({ repositoryRoot, workdir });

  const calls = [];
  const spawnProcess = (command, arguments_, options) => {
    calls.push({ command, arguments_, input: options.input });
    return { error: undefined, status: 0, stderr: '' };
  };

  await runSqlSuite('punch_engine_test.sql', { workdir, spawnProcess });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].arguments_, buildDatabaseShellArguments());
  assert.equal(
    calls[0].input,
    await readFile(path.join(repositoryRoot, 'supabase/tests/sql/punch_engine_test.sql'), 'utf8'),
  );

  await assert.rejects(
    runSqlSuite('punch_engine_test.sql', {
      workdir,
      spawnProcess: () => ({ error: undefined, status: 3, stderr: '' }),
    }),
    /punch_engine_test\.sql failed .*exit status 3/,
  );
});

test('parseCliCommand rejects unknown actions and additional arguments', () => {
  for (const command of ['prepare', 'start', 'reset', 'test', 'verify', 'stop']) {
    assert.equal(parseCliCommand([command]), command);
  }

  assert.throws(() => parseCliCommand([]), /Usage:/);
  assert.throws(() => parseCliCommand(['push']), /Usage:/);
  assert.throws(() => parseCliCommand(['reset', '--linked']), /Usage:/);
  assert.throws(() => parseCliCommand(['test', '--db-url', 'postgresql:\/\/example']), /Usage:/);
});

test('executeLocalCommand verifies a clean local database in a fixed sequence', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'attendance-verify-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const workdir = path.join(temporaryRoot, 'workspace');
  const cliCalls = [];
  const suiteCalls = [];

  await executeLocalCommand('verify', {
    assertDocker: async () => {},
    repositoryRoot,
    workdir,
    runSupabase: async (arguments_) => {
      cliCalls.push(arguments_);
    },
    runSuite: async (suiteFile) => {
      suiteCalls.push(suiteFile);
    },
  });

  // The database is rebuilt before anything reads it, and the suites run in a
  // fixed order against that rebuilt state.
  assert.deepEqual(cliCalls, [
    buildSupabaseArguments('start', { workdir }),
    buildSupabaseArguments('reset', { workdir }),
  ]);
  assert.deepEqual(suiteCalls, [
    'punch_engine_test.sql',
    'alert_engine_test.sql',
    'read_api_test.sql',
    'review_api_test.sql',
    'admin_api_test.sql',
    'sessions_api_test.sql',
    'workforce_api_test.sql',
    'reports_api_test.sql',
    'security_invariants_test.sql',
  ]);
});

test('repository development defaults cannot target production', async () => {
  const [config, environmentExample, workflow, packageManifest] = await Promise.all([
    readFile(path.join(repositoryRoot, 'supabase', 'config.toml'), 'utf8'),
    readFile(path.join(repositoryRoot, '.env.example'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ]);

  assert.match(config, /^project_id = "attendance-local"$/m);
  assert.doesNotMatch(config, new RegExp(productionProjectRef));
  assert.match(environmentExample, /^VITE_SUPABASE_URL=http:\/\/127\.0\.0\.1:54321$/m);
  assert.doesNotMatch(environmentExample, new RegExp(productionProjectRef));
  assert.doesNotMatch(workflow, /SUPABASE_DB_URL/);
  assert.match(workflow, /npm run db:verify/);

  const manifest = JSON.parse(packageManifest);
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts['db:verify'], 'node scripts/local-supabase.mjs verify');
});

test('SQL verification files are plain SQL and local-only', async () => {
  const suiteDirectory = path.join(repositoryRoot, 'supabase', 'tests', 'sql');
  const suiteFiles = (await readdir(suiteDirectory)).filter((name) => name.endsWith('.sql'));

  assert.ok(suiteFiles.includes('punch_engine_test.sql'));
  assert.ok(suiteFiles.includes('alert_engine_test.sql'));
  assert.ok(suiteFiles.includes('read_api_test.sql'));
  assert.ok(suiteFiles.includes('review_api_test.sql'));
  assert.ok(suiteFiles.includes('admin_api_test.sql'));
  assert.ok(suiteFiles.includes('sessions_api_test.sql'));
  assert.ok(suiteFiles.includes('workforce_api_test.sql'));
  assert.ok(suiteFiles.includes('reports_api_test.sql'));
  assert.ok(suiteFiles.includes('security_invariants_test.sql'));

  for (const suiteFile of suiteFiles) {
    const suite = await readFile(path.join(suiteDirectory, suiteFile), 'utf8');

    // Meta-commands keep a suite tied to one client. These files stay plain SQL
    // that any client can run; ON_ERROR_STOP is passed on the command line.
    assert.doesNotMatch(suite, /^\\/m, suiteFile);
    assert.doesNotMatch(suite, /SUPABASE_DB_URL/, suiteFile);
    assert.doesNotMatch(suite, /live database/i, suiteFile);

    // A suite that writes has to end by throwing its writes away. The security
    // invariants only read, so they open no transaction to close.
    if (/^begin;\s*$/m.test(suite)) {
      assert.match(suite, /\nrollback;\s*$/i, suiteFile);
    }
  }
});

test('runSupabaseCli launches the pinned cross-platform CLI entrypoint', async () => {
  await runSupabaseCli(['--version']);
});

test('assertDockerAvailable fails closed when the local runtime is unavailable', () => {
  const missingRuntime = () => ({
    error: Object.assign(new Error('docker not found'), { code: 'ENOENT' }),
    status: null,
    stderr: '',
  });

  assert.throws(
    () => assertDockerAvailable({ spawnProcess: missingRuntime }),
    /Docker Desktop.*No remote fallback/,
  );

  assert.doesNotThrow(() =>
    assertDockerAvailable({
      spawnProcess: () => ({ error: undefined, status: 0, stderr: '' }),
    }),
  );
});

test('development documentation requires the guarded local workflow', async () => {
  const [readme, contributing, runbook] = await Promise.all([
    readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
    readFile(path.join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docs', 'runbook.md'), 'utf8'),
  ]);

  for (const document of [readme, contributing, runbook]) {
    assert.match(document, /npm run db:verify/);
    assert.doesNotMatch(document, /safe[^\n]*live database/i);
    assert.doesNotMatch(document, /psql "\$SUPABASE_DB_URL"[^\n]*punch_engine_test/);
  }

  assert.match(readme, /docs\/local-development\.md/);
  assert.match(contributing, /docs\/local-development\.md/);
});

test('the documented restore cannot be aimed at production', async () => {
  // free-plan.md is checked on its own rather than in the loop above: it
  // documents an operations procedure, not the local development workflow, so
  // it has no reason to mention `npm run db:verify`.
  const freePlan = await readFile(path.join(repositoryRoot, 'docs', 'free-plan.md'), 'utf8');

  // `SUPABASE_DB_URL` holds production in every shell where the backup has ever
  // been debugged. A restore snippet that reads it is a restore aimed at the
  // database the help desk runs on, and it works by accident when the operator
  // forgets to reassign it. The procedure uses a name production never occupies.
  assert.doesNotMatch(freePlan, /psql "\$SUPABASE_DB_URL"/);
  assert.match(freePlan, /RESTORE_TARGET_DB_URL/);

  // The guard has to name the production ref in order to refuse it.
  assert.ok(
    freePlan.includes(productionProjectRef),
    'the restore procedure must name the production project ref in its refusal guard',
  );

  // Without both of these, psql ploughs through every error and exits 0, so a
  // half-applied restore reports success -- which is the failure that makes a
  // drill worthless.
  assert.match(freePlan, /ON_ERROR_STOP=1/);
  assert.match(freePlan, /--single-transaction/);
});

test('the backup CLI is pinned to the version the repository develops against', async () => {
  // The CLI is installed two different ways: `supabase` in devDependencies for
  // local work and CI, and supabase/setup-cli for the backup workflow. The
  // shape of a dump is version specific -- the excluded schemas and the sed
  // rewrites both move between releases -- and backup.yml asserts against one
  // version's output. A comment there asks for the two to be bumped together,
  // which is the kind of instruction that holds until the day it does not.
  const workflow = await readFile(
    path.join(repositoryRoot, '.github', 'workflows', 'backup.yml'),
    'utf8',
  );
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );

  const pinned = /supabase\/setup-cli@v\d+\s+with:\s+version:\s*(\S+)/.exec(workflow);
  assert.ok(pinned, 'backup.yml must pin an explicit supabase/setup-cli version');

  // `latest` resolves through an anonymous api.github.com call that is rate
  // limited per runner IP, and it silently changes the dump's shape.
  assert.notEqual(pinned[1], 'latest', 'the backup CLI version must not be `latest`');

  assert.equal(
    pinned[1],
    manifest.devDependencies.supabase,
    'backup.yml and the supabase devDependency must name the same CLI version',
  );
});
