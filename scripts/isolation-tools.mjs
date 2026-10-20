// Trusted build/test orchestrator: no application import and no inherited provider config.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {root, isolatedEnvironment, denied} from './isolation-policy.mjs';
const command = process.argv[2];
const business = command === 'business-test';
const location = business ? JSON.parse(fs.readFileSync(path.join(root, '.runtime/business-recheck-location.json'), 'utf8')) : undefined;
const env = isolatedEnvironment(location ? {PVS_ISOLATION_SESSION: location.session, DATABASE_URL: 'file:' + path.join(location.session, 'session.db').replaceAll('\\', '/'), PROJECTS_ROOT: path.join(location.session, 'projects')} : {});
for (const dir of ['home', 'tmp', 'projects']) fs.mkdirSync(path.join(env.PVS_ISOLATION_SESSION, dir), {recursive: true});
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
const choices = {
  build: [compiler, '-p', path.join(root, 'tsconfig.json')],
  typecheck: [compiler, '--noEmit', '-p', path.join(root, 'tsconfig.json')],
  'browser-test': ['--test', '--test-concurrency=1', path.join(root, 'tests/browser-click-isolated.test.mjs')],
  test: ['--test', '--test-concurrency=1', path.join(root, 'tests/isolation-boundary-negative.test.mjs')],
  'business-test': ['--test', '--test-concurrency=1', path.join(root, 'tests/isolation-business-u2-u5.test.mjs')]
};
if (!choices[command] || process.argv.length !== 3) denied('ISOLATION_TOOL_NOT_ALLOWLISTED');
// No npm hooks, package downloads, migrations or generated-client writes.
const child = spawn(process.execPath, choices[command], {cwd: root, env, windowsHide: true, stdio: 'inherit', shell: false});
child.once('error', error => { console.error(error.code ?? 'ISOLATION_TOOL_FAILED'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
