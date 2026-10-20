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
import cluster from 'node:cluster';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {assertEnvironment, assertClientOptions, confined, guardSymbol, root, denied} from './isolation-policy.mjs';

// First operation: reject missing or production configuration before importing application code.
const scope = assertEnvironment();
const artifactIo = {link: fsp.link.bind(fsp), unlink: fsp.unlink.bind(fsp), readFile: fsp.readFile.bind(fsp)};
if (globalThis[guardSymbol]) denied('ISOLATION_GUARD_ALREADY_INSTALLED');
const counts = {};
const reject = code => function () { counts[code] = (counts[code] ?? 0) + 1; denied(code); };
globalThis.fetch = reject('ISOLATION_NETWORK_DENIED');
if ('WebSocket' in globalThis) globalThis.WebSocket = reject('ISOLATION_NETWORK_DENIED');
for (const api of [http, https]) for (const key of ['request', 'get']) api[key] = reject('ISOLATION_NETWORK_DENIED');
http2.connect = reject('ISOLATION_NETWORK_DENIED');
for (const key of ['connect', 'createConnection']) net[key] = reject('ISOLATION_NETWORK_DENIED');
net.Socket.prototype.connect = reject('ISOLATION_NETWORK_DENIED');
tls.connect = reject('ISOLATION_NETWORK_DENIED');
dgram.createSocket = reject('ISOLATION_NETWORK_DENIED');
dgram.Socket = reject('ISOLATION_NETWORK_DENIED');
dns.Resolver = reject('ISOLATION_NETWORK_DENIED');
for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key) && typeof dns[key] === 'function') dns[key] = reject('ISOLATION_NETWORK_DENIED');
for (const key of Object.keys(dns.promises)) if (typeof dns.promises[key] === 'function') dns.promises[key] = reject('ISOLATION_NETWORK_DENIED');
// Node's listen(host) calls lookup even for a numeric address. Resolve this literal
// locally, without invoking the OS resolver; all outgoing sockets remain denied.
dns.lookup = (hostname, options, callback) => {
  if (hostname !== '127.0.0.1') return reject('ISOLATION_NETWORK_DENIED')();
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof callback !== 'function') denied('ISOLATION_DNS_CALLBACK_REQUIRED');
  queueMicrotask(() => options?.all ? callback(null, [{address: '127.0.0.1', family: 4}]) : callback(null, '127.0.0.1', 4));
};
dns.promises.lookup = async hostname => {
  if (hostname !== '127.0.0.1') return reject('ISOLATION_NETWORK_DENIED')();
  return {address: '127.0.0.1', family: 4};
};
for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) child[key] = reject('ISOLATION_REAL_EXECUTION_DENIED');
child.ChildProcess.prototype.spawn = reject('ISOLATION_REAL_EXECUTION_DENIED');
workers.Worker = reject('ISOLATION_REAL_EXECUTION_DENIED');
cluster.fork = reject('ISOLATION_REAL_EXECUTION_DENIED');
if (process.execve) process.execve = reject('ISOLATION_REAL_EXECUTION_DENIED');

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const options = typeof args[0] === 'object' ? args[0] : {port: args[0], host: args[1]};
  if (options.host !== '127.0.0.1' || !Number.isInteger(options.port) || ![0, scope.port].includes(options.port)) denied('ISOLATION_LISTEN_DENIED');
  return listen.apply(this, args);
};

// Keep unpatched primitives for validation, avoiding recursion through fs wrappers.
const original = {existsSync: fs.existsSync, realpathSync: fs.realpathSync, statSync: fs.statSync};
function check(candidate, write = false) {
  const current = {existsSync: fs.existsSync, realpathSync: fs.realpathSync, statSync: fs.statSync};
  Object.assign(fs, original);
  try { return confined(candidate, write ? scope.session : root); }
  finally { Object.assign(fs, current); }
}
const reads = ['readFile', 'readdir', 'readlink', 'realpath', 'stat', 'lstat', 'access', 'opendir', 'watch', 'watchFile'];
const writes = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'utimes', 'mkdtemp'];
for (const [names, write] of [[reads, false], [writes, true]]) {
  for (const key of names) {
    for (const [api, name] of [[fs, key], [fs, key + 'Sync'], [fsp, key]]) {
      if (typeof api[name] !== 'function') continue;
      const fn = api[name].bind(api);
      api[name] = function (candidate, ...args) { check(candidate, write); return fn(candidate, ...args); };
      if (fn.name === 'bound realpathSync' && original.realpathSync.native) {
        api[name].native = function (candidate, ...args) { check(candidate); return original.realpathSync.native(candidate, ...args); };
      }
    }
  }
}
for (const [api, name] of [[fs, 'open'], [fs, 'openSync'], [fsp, 'open']]) {
  const fn = api[name].bind(api);
  api[name] = function (candidate, flags, ...args) { check(candidate, typeof flags === 'number' ? flags !== 0 : /[wa+]/.test(flags)); return fn(candidate, flags, ...args); };
}
for (const [name, write] of [['createReadStream', false], ['createWriteStream', true]]) {
  const fn = fs[name].bind(fs);
  fs[name] = function (candidate, ...args) { check(candidate, write); return fn(candidate, ...args); };
}
for (const name of ['rename', 'copyFile', 'cp']) for (const [api, key] of [[fs, name], [fs, name + 'Sync'], [fsp, name]]) {
  if (!api[key]) continue;
  const fn = api[key].bind(api);
  api[key] = function (from, to, ...args) { check(from, name === 'rename'); check(to, true); return fn(from, to, ...args); };
}
for (const name of ['link', 'symlink']) for (const [api, key] of [[fs, name], [fs, name + 'Sync'], [fsp, name]]) if (api[key]) api[key] = reject('ISOLATION_LINK_CREATION_DENIED');
fs.existsSync = candidate => { check(candidate); return original.existsSync(candidate); };

// A guarded client cannot accept an alternate production datasource either.
async function publishImmutableFile({tempPath, targetPath, sha256}) {
  check(tempPath, true); check(targetPath, true);
  // A single atomic publish primitive, not a general link API. Both endpoints
  // must be new owned project files and the temporary inode is removed before return.
  if (!withinProjects(tempPath) || !withinProjects(targetPath) || !tempPath.startsWith(targetPath + '.') || !/\.[0-9a-f-]{36}\.tmp$/i.test(tempPath) || original.existsSync(targetPath)) denied('ISOLATION_IMMUTABLE_SCOPE_DENIED');
  if (createHash('sha256').update(await artifactIo.readFile(tempPath)).digest('hex') !== sha256) denied('ISOLATION_IMMUTABLE_BYTES_CHANGED');
  await artifactIo.link(tempPath, targetPath);
  await artifactIo.unlink(tempPath);
}
function withinProjects(candidate) { const rel = path.relative(scope.projects, path.resolve(candidate)); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
Object.defineProperty(globalThis, guardSymbol, {value: Object.freeze({contract: 'pvs-local-deny-execution-v1', assertEnvironment, assertClientOptions, publishImmutableFile, scope: Object.freeze(scope), counters: () => ({...counts})}), writable: false, configurable: false});
syncBuiltinESMExports();
