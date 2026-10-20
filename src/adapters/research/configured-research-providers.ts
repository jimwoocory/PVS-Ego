import fs from "node:fs";
import type {ArtifactRepository} from "../../application/ports/artifact-repository.js";
import {DomainValidationError} from "../../domain/validation.js";
import {HttpWebResearchProvider} from "./http-web-research-provider.js";
import {ExternalBrowserResearchProvider} from "./external-browser-research-provider.js";
import {HybridBrowserResearchProvider} from "./public-search-research-provider.js";
import {EgoCliResearchRuntime,egoResearchConfigSchema} from "./ego-cli-research-runtime.js";
import {EgoBrowserResearchProvider,EgoAwareWebResearchProvider} from "./ego-browser-research-provider.js";

export function configuredResearchProviders(artifacts:ArtifactRepository,projectsRoot:string,env:NodeJS.ProcessEnv=process.env){
  const engine=env.PVS_BROWSER_RESEARCH_ENGINE?.trim()||"external",http=new HttpWebResearchProvider({allowPrivateNetwork:env.PVS_RESEARCH_ALLOW_PRIVATE==="1"});
  if(engine==="external")return {browser:new HybridBrowserResearchProvider(new ExternalBrowserResearchProvider(env.PVS_BROWSER_RESEARCH_URL?.trim()??"")),web:http};
  if(engine!=="ego"||!env.PVS_EGO_RESEARCH_CONFIG)throw new DomainValidationError("浏览器研究候选必须明确选择external或配置完整的ego；不会自动切换引擎");
  const config=egoResearchConfigSchema.parse(JSON.parse(fs.readFileSync(env.PVS_EGO_RESEARCH_CONFIG,"utf8")));
  const ego=new EgoBrowserResearchProvider(new EgoCliResearchRuntime(config),artifacts,projectsRoot,config);
  return {browser:ego,web:new EgoAwareWebResearchProvider(http,ego)};
}
