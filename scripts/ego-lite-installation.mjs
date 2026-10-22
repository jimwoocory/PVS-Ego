import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';

export const installationFile=path.join(root,'.runtime/ego-lite-installation.json');
export const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const bridgeSources=['execution/go-ego-bridge/main.go','execution/go-ego-bridge/worker.mjs','execution/go-ego-bridge/lifetime_windows.go','execution/go-ego-bridge/lifetime_other.go','execution/go-ego-bridge/ops.go','execution/go-ego-bridge/ops-worker.mjs'];
export function localFile(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile()||fs.statSync(file).nlink!==1)throw Error('EGO_LITE_PHYSICAL_FILE_REQUIRED');
  return file;
}
function readInstallation(file){
  confined(file,path.join(root,'.runtime'));
  const value=JSON.parse(fs.readFileSync(localFile(file),'utf8'));
  if(value.contract!=='pvs-ego-lite-owned-workbench-v1'||value.root!==root||value.platform!==process.platform||value.node!==process.execPath||!Array.isArray(value.pins)||value.pins.length<6)throw Error('EGO_LITE_INSTALLATION_INVALID');
  confined(value.bridge,path.join(root,'.runtime'));
  const required=[value.node,value.bridge,value.cli,value.sdk,value.electron,value.hostMain,...bridgeSources.map(p=>path.join(root,p))];
  if(new Set(value.pins.map(p=>p.file)).size!==value.pins.length||required.some(file=>!value.pins.some(p=>p.file===file)))throw Error('EGO_LITE_PIN_MISSING');
  return value;
}
export function loadInstallation(file=installationFile){
 const value=readInstallation(file);
 for(const pin of value.pins)if(!/^[a-f0-9]{64}$/.test(pin.sha256)||digest(localFile(pin.file))!==pin.sha256)throw Error('EGO_LITE_PIN_CHANGED');
 return value;
}
export async function loadInstallationAsync(file=installationFile){
 const value=readInstallation(file),manifest=fs.readFileSync(file,'utf8');
 for(const pin of value.pins){
  if(!/^[a-f0-9]{64}$/.test(pin.sha256))throw Error('EGO_LITE_PIN_CHANGED');
  const physical=localFile(pin.file),before=fs.statSync(physical),hash=createHash('sha256');
  for await(const chunk of fs.createReadStream(physical,{highWaterMark:262144}))hash.update(chunk);
  const after=fs.statSync(localFile(physical));
  if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||hash.digest('hex')!==pin.sha256)throw Error('EGO_LITE_PIN_CHANGED');
 }
 if(fs.readFileSync(localFile(file),'utf8')!==manifest||JSON.stringify(readInstallation(file))!==JSON.stringify(value))throw Error('EGO_LITE_INSTALLATION_CHANGED');
 return value;
}
