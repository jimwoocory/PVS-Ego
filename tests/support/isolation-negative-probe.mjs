import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import child from 'node:child_process';
import workers from 'node:worker_threads';
import {syncBuiltinESMExports, createRequire} from 'node:module';
import {root, assertEnvironment, guardSymbol} from '../../scripts/isolation-policy.mjs';

const mode = process.argv[2];
const formal = path.resolve(root, '../__pvs_forbidden_production__');
let reached = 0;
const sentinel = () => { reached++; throw new Error('UNSAFE_ORIGINAL_SENTINEL_REACHED'); };
const blocked = fn => assert.throws(fn, /ISOLATION_/);
const result = extra => console.log('PVS_BOUNDARY_RESULT ' + JSON.stringify({mode, unsafeOriginalCalls: reached, ...extra}));

if (mode === 'raw-application') {
  delete process.env.DATABASE_URL;
  await assert.rejects(import('../../dist/src/web/server.js'), /ISOLATION_GUARD_REQUIRED/);
  assert.equal(process.env.DATABASE_URL, undefined);
  result({noEnvironmentFallback: true});
} else if (mode === 'raw-prisma') {
  delete process.env.DATABASE_URL;
  await assert.rejects(import('@prisma/client'), /ISOLATION_GUARD_REQUIRED/);
  assert.equal(process.env.DATABASE_URL, undefined);
  result({noEnvironmentFallback: true});
} else if (mode === 'raw-transports') {
  for (const module of ['../../dist/src/adapters/ai/hermes-structured-ai-runtime.js', '../../dist/src/adapters/douyin/yht-douyin-read-evidence-bridge.js']) {
    await assert.rejects(import(module), /ISOLATION_GUARD_REQUIRED/);
  }
  result({unprotectedExecutorImportsDenied: true});
} else if (mode === 'bad-environment') {
  blocked(() => assertEnvironment());
  result({rejectedBeforeClientImport: true});
} else if (mode === 'guarded-transports') {
  // Originals are inert sentinels: a failed negative test still cannot send or execute.
  globalThis.fetch = sentinel;
  for (const x of [http, https]) for (const k of ['request', 'get']) x[k] = sentinel;
  http2.connect = sentinel;
  net.Socket.prototype.connect = sentinel; net.connect = sentinel; net.createConnection = sentinel;
  tls.connect = sentinel; dns.lookup = sentinel; dns.resolve = sentinel; dns.Resolver = sentinel;
  dgram.createSocket = sentinel;
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[k] = sentinel;
  workers.Worker = sentinel;
  const originalListen = net.Server.prototype.listen; net.Server.prototype.listen = sentinel;
  syncBuiltinESMExports();
  await import('../../scripts/isolation-guard.mjs');
  const operations = [
    () => fetch('https://example.invalid'), () => fetch('http://127.0.0.1:3090'),
    () => http.request('http://127.0.0.1:19422'), () => https.get('https://example.invalid'),
    () => http2.connect('https://example.invalid'), () => net.connect(3090, '127.0.0.1'),
    () => new net.Socket().connect(3090, '127.0.0.1'), () => tls.connect(443, 'example.invalid'),
    () => dns.lookup('example.invalid', sentinel), () => new dns.Resolver(),
    () => dgram.createSocket('udp4'), () => new workers.Worker(''),
    ...['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(k => () => child[k]('__pvs_inert_negative_fixture__')),
    () => new child.ChildProcess().spawn({}),
    () => net.createServer().listen(3090, '127.0.0.1'),
    () => net.createServer().listen(0, '0.0.0.0')
  ];
  for (const operation of operations) blocked(operation);
  assert.equal(reached, 0);
  result({deniedOperations: operations.length, counters: globalThis[guardSymbol].counters()});
  net.Server.prototype.listen = originalListen;
} else if (mode === 'guarded-filesystem') {
  const read = fs.readFileSync, write = fs.writeFileSync;
  fs.readFileSync = (p, ...a) => path.resolve(String(p)).startsWith(formal) ? sentinel() : read(p, ...a);
  fs.writeFileSync = (p, ...a) => path.resolve(String(p)).startsWith(formal) ? sentinel() : write(p, ...a);
  syncBuiltinESMExports();
  await import('../../scripts/isolation-guard.mjs');
  blocked(() => fs.readFileSync(path.join(formal, '.env')));
  blocked(() => fs.writeFileSync(path.join(formal, 'projects', 'never-created'), ''));
  blocked(() => fs.writeFileSync(path.join(root, 'src', 'never-created.ts'), ''));
  blocked(() => fs.readFileSync(path.resolve(root, '../__pvs_forbidden_source__/.env')));
  blocked(() => fs.symlinkSync(formal, path.join(process.env.PVS_ISOLATION_SESSION, 'never-created-link'), 'junction'));
  blocked(() => fs.readFileSync(path.join(process.env.PVS_ISOLATION_SESSION, 'escape-junction', '.env')));
  const own = path.join(process.env.PROJECTS_ROOT, 'local-sentinel.txt');
  await fsp.writeFile(own, 'LOCAL_ONLY'); assert.equal(await fsp.readFile(own, 'utf8'), 'LOCAL_ONLY');
  assert.equal(reached, 0); result({localReadWriteWorks: true, outsideReadsAndWritesDenied: true});
} else if (mode === 'guarded-prisma') {
  await import('../../scripts/isolation-guard.mjs');
  const {PrismaClient} = createRequire(import.meta.url)('@prisma/client');
  blocked(() => new PrismaClient({datasourceUrl: 'file:' + path.join(formal, 'prisma/dev.db').replaceAll('\\', '/')}));
  blocked(() => new PrismaClient({datasources: {db: {url: 'file:' + path.join(formal, 'prisma/dev.db').replaceAll('\\', '/')}}}));
  blocked(() => new PrismaClient({adapter: {provider: 'sqlite'}}));
  const db = new PrismaClient();
  assert.equal(await db.project.count(), 0);
  await db.project.create({data: {id: 'local-boundary-sentinel', name: '隔离数据库正向哨兵', status: 'DRAFT', targetDurationMs: 15000}});
  assert.equal(await db.project.count(), 1);
  await db.$disconnect(); result({localDatabaseReadWriteWorks: true, alternateDatasourceDenied: true});
} else if (mode === 'guarded-app') {
  let intervals = 0;
  globalThis.setInterval = () => { intervals++; throw new Error('BACKGROUND_WORKER_TRAP'); };
  await import('../../scripts/isolation-guard.mjs');
  const {createDefaultDependencies, createAppServer} = await import('../../dist/src/web/server.js');
  const deps = createDefaultDependencies(), server = createAppServer(deps);
  blocked(() => deps.provider.submit({}));
  blocked(() => deps.douyinBrowserRuntime.publish({}));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(intervals, 0);
  await new Promise(resolve => server.close(resolve));
  const {prisma} = await import('../../dist/src/adapters/db/prisma-client.js');
  assert.equal(await prisma.project.count(), 0);
  await prisma.$disconnect();
  result({applicationImportsAndLocalListenerWork: true, backgroundIntervals: intervals, counters: globalThis[guardSymbol].counters()});
} else throw new Error('UNKNOWN_NEGATIVE_PROBE');
