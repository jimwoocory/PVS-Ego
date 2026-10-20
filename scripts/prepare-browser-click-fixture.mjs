// Trusted synthetic-media preparation; application children still cannot execute tools.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {root,confined} from './isolation-policy.mjs';

const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--ffmpeg'||args[2]!=='--ffprobe')throw Error('USAGE: prepare-browser-click-fixture --ffmpeg ABSOLUTE_LOCAL_PATH --ffprobe ABSOLUTE_LOCAL_PATH');
const binaries=args.filter((_,i)=>i===1||i===3).map((file,i)=>{
  if(!path.isAbsolute(file))throw Error('PINNED_LOCAL_EXECUTABLE_REQUIRED');
  const real=fs.realpathSync.native(file),name=path.basename(real).toLowerCase();
  if(name!==(i===0?'ffmpeg':'ffprobe')+(process.platform==='win32'?'.exe':'')||!fs.statSync(real).isFile())throw Error('EXPECTED_LOCAL_MEDIA_TOOL_REQUIRED');
  return real;
});
const sessions=path.join(root,'.runtime/isolation-sessions');confined(sessions,root);
const session=path.join(sessions,'browser-media-'+randomUUID());fs.mkdirSync(session);const evidence=path.join(session,'evidence'),media=path.join(session,'media');
for(const dir of [evidence,media,path.join(media,'frames'),path.join(session,'tmp'),path.join(session,'home')])fs.mkdirSync(dir);
const env={};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PATH:path.dirname(process.execPath),HOME:path.join(session,'home'),USERPROFILE:path.join(session,'home'),TEMP:path.join(session,'tmp'),TMP:path.join(session,'tmp')});
const commands=[],hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(executable,argv){
  commands.push({executable,argv});const response=spawnSync(executable,argv,{cwd:session,env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  if(response.status!==0)throw Error('SYNTHETIC_MEDIA_PREP_FAILED: '+(response.error?.code??response.stderr));return response.stdout;
}
const video=path.join(media,'synthetic-local.mp4');
run(binaries[0],['-v','error','-nostdin','-protocol_whitelist','file,pipe','-f','lavfi','-i','color=c=blue:s=480x270:r=5:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
run(binaries[0],['-v','error','-nostdin','-protocol_whitelist','file,pipe','-i',video,'-an','-vf','fps=5','-start_number','0',path.join(media,'frames/frame-%02d.jpg')]);
const decoded=JSON.parse(run(binaries[1],['-v','error','-protocol_whitelist','file,pipe','-select_streams','v','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',video]));
const pts=decoded.frames.map(frame=>Math.round(Number(frame.best_effort_timestamp_time)*1000));
if(JSON.stringify(pts)!==JSON.stringify(Array.from({length:10},(_,i)=>i*200)))throw Error('SYNTHETIC_PTS_MISMATCH');
const names=fs.readdirSync(path.join(media,'frames')).filter(x=>x.endsWith('.jpg')).sort();if(names.length!==10)throw Error('SYNTHETIC_FRAMES_MISSING');
const manifest={contract:'LOCAL_SYNTHETIC_DECODED_MEDIA_ONLY',file:video,sha256:hash(video),info:{durationMs:2000,width:480,height:270,frameRate:5,videoCodec:'h264',audioCodec:'aac',hasAudio:true,sceneCutTimestampsMs:[]},frames:names.map((name,i)=>{const file=path.join(media,'frames',name);return {path:file,timestampMs:pts[i],mimeType:'image/jpeg',sha256:hash(file)};}),commands,executables:binaries.map(file=>({file,sha256:hash(file)})),note:'New local lavfi media; semantic observations are fixed in-process fixtures, not model/OCR evidence.'};
fs.writeFileSync(path.join(session,'media-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
const location=path.join(root,'.runtime/browser-click-location.json');
if(fs.existsSync(location))fs.copyFileSync(location,path.join(evidence,'previous-location.json'),fs.constants.COPYFILE_EXCL);
fs.writeFileSync(location,JSON.stringify({session,outputRoot:evidence},null,2));
console.log(JSON.stringify({status:'LOCAL_SYNTHETIC_MEDIA_PREPARED',session,frames:names.length,modelsCalled:0,externalMaterial:0}));
