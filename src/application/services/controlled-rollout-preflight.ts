import {hashValue} from "../../domain/hashing.js";

export type ModelAcceptanceScope={projectId:string;providerId:string;modelId:string;endpoint:string;sourceHashes:string[];inputTokenUpperBound?:number;maxOutputTokens:number;
 price?:{inputUsdPerMillion:number;outputUsdPerMillion:number;multiplier:number;accountVerified:boolean;mappingDisabled:boolean;fallbackDisabled:boolean;expiresAt:string};maximumUsd?:number;externalMaterialConfirmed:boolean;paidCallConfirmed:boolean};
/** A reviewable quote, not an executor or a consent store. Never substitutes video credits for API dollars. */
export function preflightControlledModelAcceptance(s:ModelAcceptanceScope,now=new Date()){
 const blockers:string[]=[];let upperBoundUsd:number|undefined;
 if(s.modelId!=="deepseek-v4.1-flash")blockers.push("MODEL_CHANGE_NOT_AUTHORIZED");
 try{const u=new URL(s.endpoint);if(u.href!=="https://aihubmix.com/v1/chat/completions")throw Error();}catch{blockers.push("ENDPOINT_NOT_APPROVED");}
 if(!s.projectId||!s.providerId||!s.sourceHashes.length||s.sourceHashes.some(h=>!/^[a-f0-9]{64}$/.test(h)))blockers.push("EXACT_INPUT_SCOPE_MISSING");
 if(!Number.isSafeInteger(s.inputTokenUpperBound)||s.inputTokenUpperBound!<=0||!Number.isSafeInteger(s.maxOutputTokens)||s.maxOutputTokens<=0)blockers.push("TOKEN_UPPER_BOUND_UNKNOWN");
 const p=s.price;
 if(!p||!p.accountVerified||!p.mappingDisabled||!p.fallbackDisabled||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=now.getTime()||![p.inputUsdPerMillion,p.outputUsdPerMillion,p.multiplier].every(Number.isFinite)||p.inputUsdPerMillion<0||p.outputUsdPerMillion<0||p.multiplier<=0)blockers.push("ACCOUNT_PRICE_OR_ROUTING_UNKNOWN");
 else if(!blockers.includes("TOKEN_UPPER_BOUND_UNKNOWN"))upperBoundUsd=(s.inputTokenUpperBound!*p.inputUsdPerMillion+s.maxOutputTokens*p.outputUsdPerMillion)*p.multiplier/1e6;
 if(!Number.isFinite(s.maximumUsd)||s.maximumUsd!<0)blockers.push("USD_BUDGET_REQUIRED");
 if(upperBoundUsd!==undefined&&s.maximumUsd!==undefined&&upperBoundUsd>s.maximumUsd)blockers.push("USD_BUDGET_EXCEEDED");
 if(!s.externalMaterialConfirmed)blockers.push("MATERIAL_SCOPE_NOT_CONFIRMED");if(!s.paidCallConfirmed)blockers.push("API_CHARGE_NOT_CONFIRMED");
 return {status:blockers.length?"BLOCKED" as const:"WAITING_EXECUTION_INTEGRATION" as const,blockers,upperBoundUsd,scopeHash:hashValue(s),executionAllowed:false as const,audio:"NOT_OBSERVED",retryLimit:0,modelFallback:false};
}

export type DeploymentReadiness={baselinePreserved:boolean;localSuitePassed:boolean;realSiteContractValidated:boolean;realAccountReadPassed:boolean;realModelAcceptancePassed:boolean;rollbackRehearsed:boolean;productionConfigReviewed:boolean;deploymentExplicitlyAuthorized:boolean};
export function evaluateDeploymentReadiness(s:DeploymentReadiness){
 const blockers=Object.entries(s).filter(([,v])=>v!==true).map(([k])=>k);
 return {status:blockers.length?"NO_GO" as const:"READY_FOR_OPERATOR_REVIEW" as const,blockers,deploymentAllowed:false as const,automaticMigration:false,automaticRestart:false};
}
