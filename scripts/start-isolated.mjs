import fs from 'node:fs';
import path from 'node:path';
import {root, isolatedEnvironment} from './isolation-policy.mjs';

const env = isolatedEnvironment();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
process.chdir(root);
if (!process.argv.includes('--serve')) {
  console.log(JSON.stringify({status: 'ISOLATION_PREFLIGHT_ONLY', realExecution: 'DENIED', workers: 'DISABLED', port: Number(env.PORT), requiresExplicitServe: true}));
} else {
  for (const dir of ['home', 'home/local', 'home/roaming', 'tmp', 'projects']) fs.mkdirSync(path.join(env.PVS_ISOLATION_SESSION, dir), {recursive: true});
  await import('./isolation-guard.mjs');
  const {createDefaultDependencies, createAppServer} = await import('../dist/src/web/server.js');
  const server = createAppServer(createDefaultDependencies());
  server.listen(Number(env.PORT), '127.0.0.1', () => console.log('PVS_ISOLATED_LOCAL_ONLY_READY ' + env.PORT));
  // Foreground only; no scheduler, recovery, helper, browser or service manager.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
