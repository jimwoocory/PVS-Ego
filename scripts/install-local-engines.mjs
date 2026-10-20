// Explicit dependency preparation only. Downloads Prisma engine binaries, never project material.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.argv.length!==2||fs.realpathSync.native(root)!==root)throw Error('ENGINE_SETUP_SCOPE_DENIED');
const dir=path.join(root,'node_modules/@prisma/engines');
if(fs.realpathSync.native(dir)!==dir||JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')).version!=='6.12.0')throw Error('LOCKED_LOCAL_ENGINE_INSTALLER_REQUIRED');
const home=path.join(root,'.runtime','engine-setup');
for(const candidate of [path.join(root,'.runtime'),home]){
  if(fs.existsSync(candidate)){if(fs.realpathSync.native(candidate)!==candidate)throw Error('ENGINE_SETUP_REPARSE_DENIED');}
  else fs.mkdirSync(candidate);
}
const env={};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:home,USERPROFILE:home,LOCALAPPDATA:home,APPDATA:home,TEMP:home,TMP:home,CHECKPOINT_DISABLE:'1'});
const result=spawnSync(process.execPath,[path.join(dir,'scripts/postinstall.js')],{cwd:home,env,stdio:'inherit',windowsHide:true,timeout:120000});
if(result.error)throw result.error;process.exitCode=result.status??1;
