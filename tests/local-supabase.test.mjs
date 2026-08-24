import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertDockerAvailable,
  buildSupabaseArguments,
  executeLocalCommand,
  parseCliCommand,
  prepareWorkspace,
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
  assert.equal(migrations.length, 13);
  assert.ok(migrations.includes('20260824172955_free_plan_maintenance.sql'));
  assert.ok(migrations.includes('20260824191000_alert_evaluation_and_outbox.sql'));
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
    'engine-test': [
      '--workdir',
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      path.join(workdir, 'supabase', 'tests', 'sql', 'punch_engine_test.sql'),
    ],
    'alert-test': [
      '--workdir',
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      path.join(workdir, 'supabase', 'tests', 'sql', 'alert_engine_test.sql'),
    ],
    'security-test': [
      '--workdir',
      workdir,
      'db',
      'query',
      '--local',
      '--file',
      path.join(workdir, 'supabase', 'tests', 'sql', 'security_invariants_test.sql'),
    ],
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
  const calls = [];
  const runSupabase = async (arguments_) => {
    calls.push(arguments_);
  };

  await executeLocalCommand('verify', {
    assertDocker: async () => {},
    repositoryRoot,
    workdir,
    runSupabase,
  });

  assert.deepEqual(calls, [
    buildSupabaseArguments('start', { workdir }),
    buildSupabaseArguments('reset', { workdir }),
    buildSupabaseArguments('engine-test', { workdir }),
    buildSupabaseArguments('alert-test', { workdir }),
    buildSupabaseArguments('security-test', { workdir }),
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
  assert.ok(suiteFiles.includes('security_invariants_test.sql'));

  for (const suiteFile of suiteFiles) {
    const suite = await readFile(path.join(suiteDirectory, suiteFile), 'utf8');

    // psql meta-commands would not survive `supabase db query`.
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
