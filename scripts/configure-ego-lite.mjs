// Explicit offline preparation. This never reads or imports an existing profile.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';
import {installationFile,digest,localFile,bridgeSources,loadInstallation} from './ego-lite-installation.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--go'||args[2]!=='--ego-root'||!path.isAbsolute(args[1])||!path.isAbsolute(args[3])||process.platform!=='win32')throw Error('EXPLICIT_WINDOWS_GO_AND_EGO_ROOT_REQUIRED');
localFile(args[1]);
const egoRoot=fs.realpathSync(args[3]),hostRoot=path.join(egoRoot,'package/ego-browser-windows');
const files={node:process.execPath,cli:path.join(hostRoot,'src/cli.mjs'),sdk:path.join(egoRoot,'package/ego-browser/dist/out/index.js'),electron:path.join(hostRoot,'node_modules/electron/dist/electron.exe'),hostMain:path.join(hostRoot,'src/main.mjs')};
Object.values(files).forEach(localFile);
const session=confined(path.join(root,'.runtime','ego-lite-install-'+randomUUID()));fs.mkdirSync(session,{recursive:true});
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:session,USERPROFILE:session,TEMP:session,TMP:session,GOTELEMETRY:'off',GOTOOLCHAIN:'local',GOPROXY:'off',GOSUMDB:'off',GOWORK:'off',GOENV:'off',GOCACHE:path.join(session,'go-cache'),GOPATH:path.join(session,'go-path')});
const bridge=path.join(session,'go-ego-bridge.exe');
await new Promise((resolve,reject)=>{
  const child=spawn(args[1],['build','-trimpath','-buildvcs=false','-o',bridge,'.'],{cwd:path.join(root,'execution/go-ego-bridge'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',(code,signal)=>{
    fs.writeFileSync(path.join(session,'build.json'),JSON.stringify({code,signal,output}));code===0?resolve():reject(Error('EGO_LITE_GO_BUILD_FAILED'));
  });
});
const hostFiles=fs.readdirSync(path.join(hostRoot,'src'),{recursive:true}).map(p=>path.join(hostRoot,'src',p)).filter(p=>fs.lstatSync(p).isFile());
const pinned=[...Object.values(files),bridge,...bridgeSources.map(p=>path.join(root,p)),...hostFiles];
const value={contract:'pvs-ego-lite-owned-workbench-v1',root,platform:process.platform,...files,bridge,pins:[...new Set(pinned)].map(file=>({file:localFile(file),sha256:digest(file)}))};
const temp=installationFile+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'});fs.renameSync(temp,installationFile);loadInstallation();
console.log('EGO_LITE_OFFLINE_INSTALLATION_PINNED');
