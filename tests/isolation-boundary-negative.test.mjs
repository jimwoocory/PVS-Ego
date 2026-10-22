import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {root, isolatedEnvironment} from '../scripts/isolation-policy.mjs';

const base = isolatedEnvironment(), probe = path.join(root, 'tests/support/isolation-negative-probe.mjs');
const location = {outputRoot:path.join(root,'.runtime','standalone-acceptance-'+randomUUID())};
fs.mkdirSync(location.outputRoot,{recursive:true});
fs.writeFileSync(path.join(root,'.runtime/standalone-test-location.json'),JSON.stringify(location));
const records = [];
function run(mode, changes = {}, options = {}) {
  const session = path.join(root, '.runtime/isolation-sessions', 'negative-' + randomUUID());
  fs.mkdirSync(path.join(session, 'projects'), {recursive: true}); fs.mkdirSync(path.join(session, 'tmp')); fs.mkdirSync(path.join(session, 'home'));
  const database = path.join(session, 'session.db'); fs.copyFileSync(base.DATABASE_URL.slice(5), database);
  const env = isolatedEnvironment({PVS_ISOLATION_SESSION: session, DATABASE_URL: 'file:' + database.replaceAll('\\', '/'), PROJECTS_ROOT: path.join(session, 'projects')});
  Object.assign(env, changes);
  const junction = path.join(session, 'escape-junction');
  if (options.junction) fs.symlinkSync(path.dirname(root), junction, process.platform==='win32'?'junction':'dir');
  let response;
  try { response = spawnSync(process.execPath, [probe, mode], {cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30000}); }
  finally { if (options.junction) { assert.equal(fs.lstatSync(junction).isSymbolicLink(), true); fs.rmdirSync(junction); } }
  const record = {mode, changes: Object.keys(changes), session, status: response.status, stdout: response.stdout, stderr: response.stderr, signal: response.signal, error: response.error?.code}; records.push(record);
  assert.equal(response.status, 0, response.stderr || response.stdout || response.error?.message);
  const result = JSON.parse(response.stdout.split(/\r?\n/).find(x => x.startsWith('PVS_BOUNDARY_RESULT ')).slice(20));
  assert.equal(result.unsafeOriginalCalls, 0); return result;
}
test('isolated boundary: fail closed before production paths, transports, tasks or application imports', async t => {
  t.after(() => fs.writeFileSync(path.join(location.outputRoot, 'negative-probes-' + Date.now() + '.json'), JSON.stringify(records, null, 2)));
  await t.test('dependencies and generated client are independent and dotenv fallback is absent', () => {
    const deps = path.join(root, 'node_modules'); assert.equal(fs.lstatSync(deps).isSymbolicLink(), false); assert.equal(fs.realpathSync(deps), deps);
    assert.equal(fs.statSync(path.join(deps,'.prisma/client/index.js')).nlink,1);
    const code = fs.readFileSync(path.join(deps, '.prisma/client/index.js'), 'utf8');
    assert.match(code, /"schemaEnvPath": null/); assert.match(code, /ISOLATION_GUARD_REQUIRED_BEFORE_PRISMA_IMPORT/);
  });
  await t.test('direct compiled application entry fails before configuration fallback', () => run('raw-application'));
  await t.test('direct generated Prisma entry fails before configuration fallback', () => run('raw-prisma'));
  await t.test('direct model and raw CLI evidence modules require the guard before import', () => run('raw-transports'));
  const formalDb = 'file:' + path.resolve(root, '../__pvs_forbidden_production__/prisma/dev.db').replaceAll('\\', '/');
  const cases = [
    ['missing database', {DATABASE_URL: ''}], ['formal database', {DATABASE_URL: formalDb}],
    ['relative database', {DATABASE_URL: 'file:./dev.db'}], ['database URI query', {DATABASE_URL: base.DATABASE_URL + '?mode=rw'}],
    ['formal projects', {PROJECTS_ROOT: path.resolve(root, '../__pvs_forbidden_production__/projects')}],
    ['missing session', {PVS_ISOLATION_SESSION: ''}], ['formal port', {PORT: '3090'}],
    ['bridge port', {PORT: '19422'}], ['worker re-enabled', {PVS_OPERATIONS_WORKER_DISABLED: '0'}],
    ['agent worker re-enabled', {PVS_AGENT_WORKER_DISABLED: '0'}], ['smart worker re-enabled', {PVS_SMART_WORKER_DISABLED: '0'}],
    ['production NODE_ENV', {NODE_ENV: 'production'}], ['provider route inherited', {PVS_CANVAS_RUNTIME_CONFIG: 'inert-sentinel'}],
    ['NODE_OPTIONS injection', {NODE_OPTIONS: '--no-warnings'}]
  ];
  for (const [label, changes] of cases) await t.test(label + ' is rejected without opening a client', () => run('bad-environment', changes));
  await t.test('fetch, HTTP, sockets, DNS, child processes, workers and unsafe listeners hit no original transport', () => assert.ok(run('guarded-transports').deniedOperations >= 20));
  await t.test('outside reads/writes, junction escape and link creation denied; owned files usable', () => run('guarded-filesystem', {}, {junction: true}));
  await t.test('Prisma alternate production datasource rejected; fresh local DB writable', () => run('guarded-prisma'));
  await t.test('actual isolated application starts local listener with zero background intervals', () => run('guarded-app'));
  await t.test('old helper, generation, migration and full-suite entries are disabled', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const key of ['prisma:generate', 'prisma:migrate', 'test:e2e', 'test:e2e:headed']) assert.match(pkg.scripts[key], /isolation-disabled/);
    for (const file of ['local-runtime-bootstrap.mjs', 'douyin-bridge-supervisor.mjs', 'douyin-ops-cdp-bridge.mjs', 'preview-redirect.mjs', 'run-isolated-tests.mjs', 'test-isolated.mjs']) {
      const response = spawnSync(process.execPath, [path.join(root, 'scripts', file)], {cwd: root, env: base, encoding: 'utf8', windowsHide: true, timeout: 5000});
      assert.notEqual(response.status, 0); assert.match(response.stderr, /ISOLATION_LEGACY_OR_REAL_ENTRY_DISABLED/);
    }
    for (const file of ['install-local-service.ps1', 'launch-douyin-browser.ps1', 'ensure-douyin-main-tab.mjs', 'hermes-json-smoke.mjs', 'douyin-research-cookie-extract.py']) assert.match(fs.readFileSync(path.join(root, 'scripts', file), 'utf8'), /ISOLATION_LEGACY_OR_REAL_ENTRY_DISABLED|isolation-disabled/);
    const start = fs.readFileSync(path.join(root, 'start-pvs.ps1'), 'utf8'), stop = fs.readFileSync(path.join(root, 'stop-pvs.ps1'), 'utf8');
    assert.doesNotMatch(start + stop, /ScheduledTask|Stop-Process|Start-Process|19422|19423|9223/);
  });
  await t.test('default launcher only checks isolation and strips inherited real configuration', () => {
    const response = spawnSync(process.execPath, [path.join(root, 'scripts/start-isolated.mjs'), '--check'], {cwd: root, env: {...base, DATABASE_URL: formalDb, PVS_CANVAS_RUNTIME_CONFIG: 'inert-sentinel'}, encoding: 'utf8', windowsHide: true, timeout: 5000});
    assert.equal(response.status, 0, response.stderr); const result = JSON.parse(response.stdout); assert.equal(result.status, 'ISOLATION_PREFLIGHT_ONLY'); assert.equal(result.requiresExplicitServe, true);
  });
  await t.test('repeated setup preserves existing database bytes',()=>{
    const hash=()=>createHash('sha256').update(fs.readFileSync(base.DATABASE_URL.slice(5))).digest('hex');
    const before=hash(),response=spawnSync(process.execPath,[path.join(root,'scripts/initialize-isolated.mjs')],{cwd:root,env:base,encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(response.status,0,response.stderr+response.stdout);assert.match(response.stdout,/EXISTING_STATE_PRESERVED/);assert.equal(hash(),before);
  });
  await t.test('fresh relocated code and physical dependencies initialize without source checkout or old local state',async()=>{
    const relocated=path.join(root,'.runtime','relocated PVS 独立 '+randomUUID());fs.mkdirSync(relocated);
    for(const name of ['node_modules','scripts','prisma','dist','config','skills','browser-extension','execution','src','tests']){
      fs.cpSync(path.join(root,name),path.join(relocated,name),{recursive:true,filter:p=>!p.endsWith('.db')});
    }
    fs.copyFileSync(path.join(root,'package.json'),path.join(relocated,'package.json'));
    const response=spawnSync(process.execPath,[path.join(relocated,'scripts/initialize-isolated.mjs')],{cwd:relocated,env:base,encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(response.status,0,response.stderr+response.stdout);assert.match(response.stdout,/EMPTY_LOCAL_ISOLATION_READY/);
    const marker=JSON.parse(fs.readFileSync(path.join(relocated,'.pvs-isolation.json'),'utf8'));
    assert.equal(marker.root,relocated);assert.ok(marker.defaultSession.startsWith(relocated+path.sep));
    assert.notEqual(fs.statSync(path.join(root,'node_modules/.prisma/client/index.js')).ino,fs.statSync(path.join(relocated,'node_modules/.prisma/client/index.js')).ino);
    // Bootstrap only: a nonexistent explicit compiler prevents any Go/Ego suite or host from starting.
    assert.equal(fs.existsSync(path.join(relocated,'.runtime/go-bridge-location.json')),false);
    const missingGo=path.join(relocated,'missing-local-go.exe');
    for(const [runner,pointer] of [
      ['run-go-bridge-isolated.mjs','go-bridge-latest-attempt.json'],
      ['run-go-research-isolated.mjs','go-research-active.json'],
      ['run-go-u1-session.mjs','go-u1-session-active.json']
    ]){
      const failed=spawnSync(process.execPath,[path.join(relocated,'scripts',runner),'--go',missingGo,'--ego-root',relocated],{cwd:relocated,env:base,encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(failed.status,1,failed.stderr+failed.stdout);
      const attempt=JSON.parse(fs.readFileSync(path.join(relocated,'.runtime',pointer),'utf8'));
      assert.ok(attempt.session.startsWith(path.join(relocated,'.runtime')+path.sep));
      assert.equal(fs.realpathSync(attempt.session),attempt.session);
      assert.equal(fs.statSync(path.join(attempt.session,'go-cache')).isDirectory(),true);
      const failure=JSON.parse(fs.readFileSync(path.join(attempt.session,'evidence/attempt-failed.json'),'utf8'));
      assert.equal(failure.code,'ENOENT');assert.ok(failure.reason.includes(missingGo),failure.reason);
      if(runner==='run-go-bridge-isolated.mjs'){
        const manifest=JSON.parse(fs.readFileSync(path.join(attempt.session,'evidence/source-manifest.json'),'utf8'));
        assert.equal(Object.keys(failure.sourceHashes).length,14);assert.deepEqual(failure.sourceHashes,manifest.sourceHashes);
        const guardSource=fs.readFileSync(path.join(relocated,'execution/go-ego-bridge/lifetime_windows.go'));
        assert.equal(failure.sourceHashes['execution/go-ego-bridge/lifetime_windows.go'],createHash('sha256').update(guardSource).digest('hex'));
      }
      assert.equal(fs.existsSync(path.join(attempt.session,'evidence/final-acceptance.json')),false);
    }
    const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    const envFile=path.join(relocated,'.env');fs.writeFileSync(envFile,fs.readFileSync(envFile,'utf8').replace(/^PORT=\d+$/m,'PORT='+port));
    const inherited={...base,DATABASE_URL:'file:'+path.resolve(root,'../__pvs_forbidden_production__/dev.db').replaceAll('\\','/'),PVS_CANVAS_RUNTIME_CONFIG:'inert-sentinel'};
    const check=spawnSync(process.execPath,[path.join(relocated,'scripts/start-isolated.mjs'),'--check'],{cwd:relocated,env:inherited,encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).port,port);
    const child=spawn(process.execPath,[path.join(relocated,'scripts/start-isolated.mjs'),'--serve'],{cwd:relocated,env:inherited,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',closed=false;child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});const completion=once(child,'exit').then(([code,signal])=>{closed=true;return {code,signal};});
    const read=p=>new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:p,timeout:2000},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('LOCAL_HTTP_TIMEOUT')));});
    try{
      const started=Date.now();while(!output.includes('PVS_ISOLATED_LOCAL_ONLY_READY')){assert.equal(closed,false,output);assert.ok(Date.now()-started<20000,output);await new Promise(resolve=>setTimeout(resolve,50));}
      const health=await read('/health'),projects=await read('/projects');assert.equal(health.status,200,health.body);assert.equal(projects.status,200);assert.match(projects.body,/产品视频/);
      fs.writeFileSync(path.join(location.outputRoot,'relocated-start.json'),JSON.stringify({relocated,port,healthStatus:health.status,projectPageStatus:projects.status,inheritedFormalConfigurationIgnored:true,oldStateCopied:false,externalCalls:0,scope:'relocated code with independently copied pinned dependencies; clean npm installation NOT_RUN'},null,2));
    }finally{
      if(!closed)child.kill();const exit=await completion;
      fs.writeFileSync(path.join(location.outputRoot,'relocated-process.json'),JSON.stringify({pid:child.pid,closed:true,...exit,output}));
    }
  });
});
