import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';

export const installationFile=path.join(root,'.runtime/ego-lite-installation.json');
export const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const bridgeSources=['execution/go-ego-bridge/main.go','execution/go-ego-bridge/worker.mjs','execution/go-ego-bridge/lifetime_windows.go','execution/go-ego-bridge/lifetime_other.go'];
export function localFile(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile()||fs.statSync(file).nlink!==1)throw Error('EGO_LITE_PHYSICAL_FILE_REQUIRED');
  return file;
}
export function loadInstallation(file=installationFile){
  confined(file,path.join(root,'.runtime'));
  const value=JSON.parse(fs.readFileSync(localFile(file),'utf8'));
  if(value.contract!=='pvs-ego-lite-owned-workbench-v1'||value.root!==root||value.platform!==process.platform||value.node!==process.execPath||!Array.isArray(value.pins)||value.pins.length<6)throw Error('EGO_LITE_INSTALLATION_INVALID');
  confined(value.bridge,path.join(root,'.runtime'));
  const required=[value.node,value.bridge,value.cli,value.sdk,value.electron,value.hostMain,...bridgeSources.map(p=>path.join(root,p))];
  if(new Set(value.pins.map(p=>p.file)).size!==value.pins.length||required.some(file=>!value.pins.some(p=>p.file===file)))throw Error('EGO_LITE_PIN_MISSING');
  for(const pin of value.pins)if(!/^[a-f0-9]{64}$/.test(pin.sha256)||digest(localFile(pin.file))!==pin.sha256)throw Error('EGO_LITE_PIN_CHANGED');
  return value;
}
