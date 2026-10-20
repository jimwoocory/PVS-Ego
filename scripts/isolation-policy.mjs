import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const guardSymbol = Symbol.for('pvs.isolation.boundary.v1');
const blockedPorts = new Set([3090, 3092, 9223, 19422, 19423]);
export function denied(code) { throw Object.assign(new Error(code), {code}); }
export function within(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
// Resolve existing ancestors too, so a missing file below a junction cannot escape.
export function confined(candidate, parent = root) {
  if (candidate instanceof URL) candidate = fileURLToPath(candidate);
  if (Buffer.isBuffer(candidate)) candidate = candidate.toString();
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) denied('ISOLATION_PATH_REQUIRED');
  const absolute = path.resolve(candidate);
  if (!within(parent, absolute)) denied('ISOLATION_PATH_OUTSIDE_ROOT');
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const next = path.dirname(existing);
    if (next === existing) denied('ISOLATION_PATH_UNRESOLVED');
    existing = next;
  }
  const resolved = fs.realpathSync.native(existing);
  if (!within(parent, resolved)) denied('ISOLATION_REPARSE_ESCAPE');
  const info = fs.statSync(existing);
  if (info.isFile() && info.nlink > 1) denied('ISOLATION_SHARED_FILE_DENIED');
  return absolute;
}
export function sessionPaths(env = process.env) {
  const session = env.PVS_ISOLATION_SESSION;
  if (!session || !path.isAbsolute(session)) denied('ISOLATION_SESSION_REQUIRED');
  confined(session, path.join(root, '.runtime', 'isolation-sessions'));
  if (path.resolve(session) === path.join(root, '.runtime', 'isolation-sessions')) denied('ISOLATION_SESSION_REQUIRED');
  const database = env.DATABASE_URL;
  if (!database?.startsWith('file:') || /[?#\0]/.test(database)) denied('ISOLATION_DATABASE_REQUIRED');
  const dbPath = database.slice(5);
  if (!path.isAbsolute(dbPath) || !dbPath.endsWith('.db')) denied('ISOLATION_DATABASE_REQUIRED');
  confined(dbPath, session);
  if (!env.PROJECTS_ROOT || !path.isAbsolute(env.PROJECTS_ROOT)) denied('ISOLATION_PROJECTS_REQUIRED');
  confined(env.PROJECTS_ROOT, session);
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || blockedPorts.has(port)) denied('ISOLATION_PORT_DENIED');
  return {session: path.resolve(session), database: path.resolve(dbPath), projects: path.resolve(env.PROJECTS_ROOT), port};
}
export function assertEnvironment(env = process.env) {
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.pvs-isolation.json'), 'utf8'));
  if (marker.contract !== 'pvs-local-deny-execution-v1' || path.resolve(marker.root) !== root || fs.realpathSync.native(root) !== root) denied('ISOLATION_ROOT_NOT_PINNED');
  const deps = path.join(root, 'node_modules');
  if (fs.lstatSync(deps).isSymbolicLink() || fs.realpathSync.native(deps) !== deps) denied('ISOLATION_SHARED_DEPENDENCIES');
  if (env.NODE_OPTIONS || env.NODE_PATH) denied('ISOLATION_NODE_INJECTION_DENIED');
  if (env.NODE_ENV !== 'test' || ['PVS_SMART_WORKER_DISABLED', 'PVS_AGENT_WORKER_DISABLED', 'PVS_OPERATIONS_WORKER_DISABLED'].some(k => env[k] !== '1')) denied('ISOLATION_WORKER_POLICY_REQUIRED');
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^(?:PVS_(?:CANVAS|EGO|DOUYIN|SOCIAL|QUOTE)|DOUYIN_|DREAMINA_|HERMES_|OPENAI_|AIHUBMIX_|ANTHROPIC_)/.test(key)) denied('ISOLATION_REAL_CONFIGURATION_DENIED');
  }
  return sessionPaths(env);
}
export function assertClientOptions(options = {}) {
  const scope = assertEnvironment();
  if (options.adapter || options.__internal || options.accelerateUrl) denied('ISOLATION_CLIENT_OVERRIDE_DENIED');
  for (const url of [options.datasourceUrl, ...Object.values(options.datasources ?? {}).map(x => x?.url)]) {
    if (url === undefined) continue;
    if (typeof url !== 'string' || !url.startsWith('file:') || /[?#\0]/.test(url) || !path.isAbsolute(url.slice(5))) denied('ISOLATION_CLIENT_DATABASE_DENIED');
    confined(url.slice(5), scope.session);
  }
  return scope;
}
export function isolatedEnvironment(overrides = {}) {
  const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const entries = {};
  const allowed = new Set(['DATABASE_URL', 'PROJECTS_ROOT', 'PORT', 'PVS_ISOLATION_SESSION', 'NODE_ENV', 'PVS_SMART_WORKER_DISABLED', 'PVS_AGENT_WORKER_DISABLED', 'PVS_OPERATIONS_WORKER_DISABLED']);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match || !allowed.has(match[1])) denied('ISOLATION_ENV_KEY_DENIED');
    entries[match[1]] = match[2];
  }
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, entries, overrides);
  const scope = sessionPaths(env);
  Object.assign(env, {PATH: path.dirname(process.execPath), HOME: path.join(scope.session, 'home'), USERPROFILE: path.join(scope.session, 'home'), LOCALAPPDATA: path.join(scope.session, 'home', 'local'), APPDATA: path.join(scope.session, 'home', 'roaming'), TEMP: path.join(scope.session, 'tmp'), TMP: path.join(scope.session, 'tmp')});
  assertEnvironment(env);
  return env;
}
