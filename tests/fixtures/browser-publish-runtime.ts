import {randomUUID} from "node:crypto";
import type {DouyinBrowserPublisherRuntime} from "../../src/application/ports/douyin-browser-publisher-runtime.js";
import type {BrowserPublishPreparationRuntime,BrowserPublishScope,BrowserPageBinding,BrowserPageSnapshot} from "../../src/application/ports/browser-publish-preparation.js";

/** Synthetic platform only. No network, cookie store, generator or real upload implementation. */
export class LocalBrowserPublishRuntime implements DouyinBrowserPublisherRuntime,BrowserPublishPreparationRuntime {
 readonly staged=this;readonly identity="local-u3-runtime";
 accountKey="profile-a";accountId="account-a";snapshot?:BrowserPageSnapshot;
 prepares=0;uploads=0;submits=0;legacyPublishes=0;inspections=0;mode:"CAPTCHA"|"READY"|"UPLOADING"="CAPTCHA";
 submitMode:"UNKNOWN"|"VERIFIED"|"UNVERIFIED"="UNKNOWN";
 async resolveAccountName(){return this.accountKey;}
 async probe(){return {ok:true,status:"READY"};}
 async check(account=this.accountKey){return {ok:true,account,status:"VALID",valid:true,platformUserId:this.accountId};}
 async login():Promise<never>{throw Error("REAL_LOGIN_FORBIDDEN");}
 async publish():Promise<never>{this.legacyPublishes++;throw Error("COMBINED_PUBLISH_FORBIDDEN");}
 async prepare(scope:BrowserPublishScope,_videoPath:string){
  this.prepares++;this.uploads++;
  this.snapshot={binding:{runtimeId:this.identity,instanceId:"instance-a",spaceId:"space-a",pageId:"page-a",documentId:randomUUID(),accountKey:scope.accountKey},account:{...scope.account},title:scope.title,description:scope.description,tags:scope.tags,declaration:scope.declaration,videoSha256:scope.videoSha256,uploadComplete:this.mode!=="UPLOADING",challenge:this.mode==="CAPTCHA"?"CAPTCHA":"NONE",control:"AGENT",connected:true};
  return structuredClone(this.snapshot);
 }
 async inspect(_binding:BrowserPageBinding){this.inspections++;if(this.snapshot!.control==="USER")throw Error("USER_OWNS_PAGE");return structuredClone(this.snapshot!);}
 async handoff(_binding:BrowserPageBinding){this.snapshot!.control="USER";}
 /** Test actor, never called by the coordinator automatically. */
 manualComplete(){this.snapshot!.challenge="NONE";}
 async resume(_binding:BrowserPageBinding){this.snapshot!.control="AGENT";return structuredClone(this.snapshot!);}
 async submit(_binding:BrowserPageBinding,_scope:BrowserPublishScope){
  this.submits++;
  if(this.submitMode==="UNKNOWN")throw Error("RESPONSE_LOST_AFTER_LOCAL_SUBMIT");
  return {ok:true,account:this.accountKey,status:this.submitMode==="VERIFIED"?"PUBLISHED_CONFIRMED":"SUBMITTED",verified:this.submitMode==="VERIFIED",externalReference:"https://www.douyin.com/video/7900000000000000002",videoId:"7900000000000000002"};
 }
}
