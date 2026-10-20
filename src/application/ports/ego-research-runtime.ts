import type {BrowserResearchBlockerCode} from "./research-provider.js";

export type EgoResearchBinding={instanceId:string;spaceId:number;spaceName:string;profileId:"Default"};
export type EgoResearchCapture={sourceUrl:string;finalUrl:string;title:string;text:string;fetchedAt:string;
  links:Array<{url:string;title:string}>;truncated:boolean;blocker?:BrowserResearchBlockerCode};
/** Browser execution only; ResearchService remains the sole business workflow. No login, click, input or publish API. */
export interface EgoResearchRuntime{
  readonly identity:string;
  open(spaceName:string):Promise<EgoResearchBinding>;
  read(binding:EgoResearchBinding,input:{url?:string;screenshotPath?:string}):Promise<EgoResearchCapture>;
}
export class EgoResearchError extends Error{
  constructor(readonly code:BrowserResearchBlockerCode,readonly detailCode?:string){super(code);this.name="EgoResearchError";}
}
