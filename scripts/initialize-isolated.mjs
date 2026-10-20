// Trusted local initializer. Never imports application code or opens an existing database.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {hardenPrismaClient} from './prisma-isolation-hardening.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fail=code=>{throw Error(code);};
function ownDirectory(relative){
  let current=root;
  for(const segment of relative.split('/')){
    current=path.join(current,segment);
    if(fs.existsSync(current)){
      if(!fs.statSync(current).isDirectory()||fs.realpathSync.native(current)!==current)fail('INITIALIZER_REPARSE_PATH_DENIED');
    }else fs.mkdirSync(current);
  }
  return current;
}
if(process.argv.length!==2)fail('INITIALIZER_ARGUMENT_NOT_ALLOWED');
if(fs.realpathSync.native(root)!==root)fail('INITIALIZER_REPARSE_ROOT_DENIED');
const markerPath=path.join(root,'.pvs-isolation.json'),envPath=path.join(root,'.env');
if(fs.existsSync(markerPath)!==fs.existsSync(envPath))fail('PARTIAL_INITIALIZATION_PRESERVED_REVIEW_REQUIRED');
for(const candidate of [path.join(root,'node_modules'),path.join(root,'prisma'),path.join(root,'scripts')]){
  if(fs.lstatSync(candidate).isSymbolicLink()||fs.realpathSync.native(candidate)!==candidate)fail('INITIALIZER_SHARED_PATH_DENIED');
}
const deps=JSON.parse(fs.readFileSync(path.join(root,'node_modules/@prisma/client/package.json'),'utf8'));
if(deps.version!=='6.12.0')fail('UNREVIEWED_PRISMA_VERSION');
// Sanitized environment: local bundled engines only; no provider credentials or parent .env.
const cliEnv={};
for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'])if(process.env[key])cliEnv[key]=process.env[key];
const setupDir=ownDirectory('.runtime/setup');
if(fs.realpathSync.native(setupDir)!==setupDir)fail('INITIALIZER_REPARSE_SETUP_DENIED');
Object.assign(cliEnv,{PATH:path.dirname(process.execPath),HOME:setupDir,USERPROFILE:setupDir,LOCALAPPDATA:setupDir,APPDATA:setupDir,TEMP:setupDir,TMP:setupDir,CHECKPOINT_DISABLE:'1',PRISMA_GENERATE_SKIP_AUTOINSTALL:'1',PRISMA_SKIP_POSTINSTALL_GENERATE:'1',DATABASE_URL:'file:'+path.join(setupDir,'never-opened.db').replaceAll('\\','/')});
const engineDir=path.join(root,'node_modules/@prisma/engines');
const queryName=process.platform==='win32'?'query_engine-windows.dll.node':fs.readdirSync(engineDir).find(x=>x.startsWith('libquery_engine')&&x.endsWith('.node'));
const schemaName=process.platform==='win32'?'schema-engine-windows.exe':fs.readdirSync(engineDir).find(x=>x.startsWith('schema-engine-'));
if(!queryName||!schemaName||!fs.existsSync(path.join(engineDir,queryName))||!fs.existsSync(path.join(engineDir,schemaName)))fail('LOCAL_PRISMA_ENGINES_REQUIRED_NO_DOWNLOAD');
Object.assign(cliEnv,{PRISMA_QUERY_ENGINE_LIBRARY:path.join(engineDir,queryName),PRISMA_SCHEMA_ENGINE_BINARY:path.join(engineDir,schemaName)});
const generation=spawnSync(process.execPath,[path.join(root,'node_modules/prisma/build/index.js'),'generate','--schema',path.join(root,'prisma/schema.prisma')],{cwd:setupDir,env:cliEnv,encoding:'utf8',windowsHide:true,timeout:60000});
fs.writeFileSync(path.join(setupDir,'generate-'+Date.now()+'.log'),(generation.error?.code??'')+'\n'+(generation.stdout??'')+(generation.stderr??''));
if(generation.status!==0)fail('LOCAL_PRISMA_GENERATION_FAILED_SEE_SETUP_LOG');
const hardened=hardenPrismaClient(root);
if(fs.existsSync(markerPath)){
  const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
  if(marker.root!==root)fail('MOVED_LOCAL_STATE_PRESERVED_USE_FRESH_CODE_CHECKOUT');
  const {isolatedEnvironment}=await import('./isolation-policy.mjs');
  isolatedEnvironment();
  console.log(JSON.stringify({status:'EXISTING_STATE_PRESERVED',root,hardenedClientEntries:hardened.length}));
  process.exit(0);
}
const sessions=ownDirectory('.runtime/isolation-sessions');
if(fs.realpathSync.native(sessions)!==sessions)fail('INITIALIZER_REPARSE_SESSIONS_DENIED');
const session=path.join(sessions,'standalone-'+randomUUID());fs.mkdirSync(session);
for(const dir of ['projects','tmp','home','home/local','home/roaming'])fs.mkdirSync(path.join(session,dir),{recursive:true});
const database=path.join(session,'session.db');fs.writeFileSync(database,'',{flag:'wx'});
const db=new DatabaseSync(database);
try{
  db.exec('CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER NOT NULL DEFAULT 0)');
  const migrations=path.join(root,'prisma/migrations');
  for(const name of fs.readdirSync(migrations).sort()){
    const sqlFile=path.join(migrations,name,'migration.sql');if(!fs.existsSync(sqlFile))continue;
    const sql=fs.readFileSync(sqlFile,'utf8');db.exec(sql);
    db.prepare('INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES (?,?,?,?,?,1)').run(randomUUID(),createHash('sha256').update(sql).digest('hex'),Date.now(),name,Date.now());
  }
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_prisma_migrations'").all()){
    if(db.prepare('SELECT count(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n!==0)fail('BOOTSTRAP_BUSINESS_ROWS_NOT_EMPTY');
  }
}finally{db.close();}
const uri=file=>'file:'+file.replaceAll('\\','/');
const env={DATABASE_URL:uri(database),PROJECTS_ROOT:path.join(session,'projects').replaceAll('\\','/'),PORT:'3097',PVS_ISOLATION_SESSION:session.replaceAll('\\','/'),NODE_ENV:'test',PVS_SMART_WORKER_DISABLED:'1',PVS_AGENT_WORKER_DISABLED:'1',PVS_OPERATIONS_WORKER_DISABLED:'1'};
fs.writeFileSync(envPath,Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n',{flag:'wx'});
fs.writeFileSync(markerPath,JSON.stringify({contract:'pvs-local-deny-execution-v1',root,defaultSession:session,u3Block:'PRESERVED',externalExecution:'DENIED'},null,2),{flag:'wx'});
console.log(JSON.stringify({status:'EMPTY_LOCAL_ISOLATION_READY',root,session,hardenedClientEntries:hardened.length,realExecution:'DENIED',workers:'DISABLED'}));
