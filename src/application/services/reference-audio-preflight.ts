import {hashValue} from "../../domain/hashing.js";

export type ReferenceAudioPreflightInput={
  projectId:string;
  intent:"CAPABILITY_TEST"|"REFERENCE_ANALYSIS";
  selected:{providerId:string;modelId:string};
  proposed:{providerId:string;modelId:string};
  source?:{artifactId:string;sha256:string;sizeBytes:number;durationMs:number;mimeType:"audio/wav"|"audio/mpeg";fileVerified:boolean};
  capability?:{providerId:string;modelId:string;sourceKind:"LOCAL_TAG"|"PROVIDER_DOCUMENT"|"PUBLIC_CATALOG";sourceUrl:string;sourceHash:string;inputModalities:string[];realAudioTestPassed:boolean};
  transport:{kind:"CHAT_INPUT_AUDIO"|"MULTIPART_TRANSCRIPTION"|"GEMINI_INLINE_AUDIO";endpoint:string;documented:boolean;implemented:boolean};
  account:{modelListed:boolean|"UNKNOWN";mappingAndFallbackVerified:boolean};
  pricing?:{currency:"USD";unit:"second"|"minute"|"million_tokens";unitPrice:number;sourceUrl:string;sourceHash:string;checkedAt:string;expiresAt:string;
    accountPriceVerified:boolean;conflictsResolved:boolean;billingIncrementSeconds?:number;minimumBillableSeconds?:number;accountMultiplier?:number};
  maximumUsd?:number;
};

/** Local preflight only. It cannot send media, switch settings, grant consent, or return execution READY. */
export function preflightReferenceAudio(input:ReferenceAudioPreflightInput,now=new Date()){
  const blockers:string[]=[],source=input.source,proof=input.capability,price=input.pricing;
  const add=(code:string)=>{if(!blockers.includes(code))blockers.push(code);};
  if(!input.projectId.trim())add("PROJECT_REQUIRED");
  if(!source)add("SOURCE_NOT_SELECTED");
  else{
    if(!source.fileVerified||!source.artifactId||!/^[a-f0-9]{64}$/.test(source.sha256))add("SOURCE_FILE_NOT_VERIFIED");
    if(!Number.isSafeInteger(source.sizeBytes)||source.sizeBytes<=0||source.sizeBytes>25_000_000)add("AUDIO_SIZE_NOT_VERIFIED");
    if(!Number.isSafeInteger(source.durationMs)||source.durationMs<=0)add("AUDIO_DURATION_NOT_VERIFIED");
    if(input.intent==="CAPABILITY_TEST"&&source.durationMs>6000)add("TEST_SCOPE_EXCEEDS_SIX_SECONDS");
  }
  const documentedAudio=Boolean(proof&&proof.sourceKind!=="LOCAL_TAG"&&proof.sourceUrl&&/^[a-f0-9]{64}$/.test(proof.sourceHash)&&
    proof.providerId===input.proposed.providerId&&proof.modelId===input.proposed.modelId&&proof.inputModalities.includes("audio"));
  if(!documentedAudio)add("AUDIO_CAPABILITY_NOT_DOCUMENTED");
  if(input.intent==="REFERENCE_ANALYSIS"&&!proof?.realAudioTestPassed)add("REAL_AUDIO_TEST_NOT_VERIFIED");
  if(!input.transport.documented)add("AUDIO_PROTOCOL_NOT_DOCUMENTED");
  if(!input.transport.implemented)add("AUDIO_TRANSPORT_NOT_IMPLEMENTED");
  try{const url=new URL(input.transport.endpoint);if(url.protocol!=="https:"||url.username||url.password)throw Error();
    if(input.transport.kind==="MULTIPART_TRANSCRIPTION"&&!url.pathname.endsWith("/audio/transcriptions"))add("AUDIO_ENDPOINT_MISMATCH");
  }catch{add("AUDIO_ENDPOINT_MISMATCH");}
  if(input.account.modelListed!==true)add("ACCOUNT_MODEL_NOT_VERIFIED");
  if(!input.account.mappingAndFallbackVerified)add("ACCOUNT_MAPPING_OR_FALLBACK_UNKNOWN");
  let publishedBaseEstimateUsd:number|undefined,accountQuoteUsd:number|undefined;
  const measuredDuration=source&&Number.isSafeInteger(source.durationMs)&&source.durationMs>0?source.durationMs/1000:undefined;
  if(!price)add("AUDIO_PRICE_UNKNOWN");
  else{
    if(price.currency!=="USD"||!Number.isFinite(price.unitPrice)||price.unitPrice<0||price.unit==="million_tokens")add("AUDIO_PRICE_UNIT_NOT_VERIFIED");
    else if(measuredDuration!==undefined)publishedBaseEstimateUsd=Number((price.unitPrice*measuredDuration/(price.unit==="minute"?60:1)).toFixed(12));
    const checked=Date.parse(price.checkedAt),expires=Date.parse(price.expiresAt);
    if(!Number.isFinite(checked)||!Number.isFinite(expires)||checked>now.getTime()||expires<=now.getTime()||expires<=checked)add("AUDIO_PRICE_EXPIRED");
    if(!price.sourceUrl||!/^[a-f0-9]{64}$/.test(price.sourceHash)||!price.accountPriceVerified)add("ACCOUNT_PRICE_NOT_VERIFIED");
    if(!price.conflictsResolved)add("PRICE_OR_PROTOCOL_CONFLICT_UNRESOLVED");
    const increment=price.billingIncrementSeconds,minimum=price.minimumBillableSeconds,multiplier=price.accountMultiplier;
    if(increment===undefined||!Number.isFinite(increment)||increment<=0||minimum===undefined||!Number.isFinite(minimum)||minimum<0||multiplier===undefined||!Number.isFinite(multiplier)||multiplier<=0)add("BILLING_RULES_UNKNOWN");
    else if(measuredDuration!==undefined&&publishedBaseEstimateUsd!==undefined&&price.accountPriceVerified&&price.conflictsResolved&&Number.isFinite(checked)&&Number.isFinite(expires)&&expires>now.getTime()&&checked<=now.getTime()){
      const chargedSeconds=Math.ceil(Math.max(measuredDuration,minimum)/increment)*increment;
      accountQuoteUsd=Number((price.unitPrice*chargedSeconds/(price.unit==="minute"?60:1)*multiplier).toFixed(12));
    }
  }
  if(input.maximumUsd===undefined||!Number.isFinite(input.maximumUsd)||input.maximumUsd<0)add("COST_LIMIT_REQUIRED");
  else if(accountQuoteUsd!==undefined&&accountQuoteUsd>input.maximumUsd)add("AUDIO_COST_EXCEEDS_LIMIT");
  const requiredConfirmations=[...(input.selected.providerId!==input.proposed.providerId||input.selected.modelId!==input.proposed.modelId?["MODEL_CHANGE"]:[]),"MEDIA_EGRESS","PAID_AUDIO_ANALYSIS"];
  return {status:blockers.length?"BLOCKED" as const:"WAITING_CONFIRMATION" as const,blockers,documentedAudio,realAudioTestPassed:proof?.realAudioTestPassed??false,
    publishedBaseEstimateUsd,accountQuoteUsd,requiredConfirmations,scopeHash:hashValue(input),expiresAt:price?.expiresAt,executionAllowed:false as const};
}
