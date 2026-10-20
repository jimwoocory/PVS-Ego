/** Presentation only: stored enums, request keys, IDs and generated prompts stay unchanged. */
export const uiLabels: Record<string, string> = {
  DRAFT: "草稿", CONFIRMED: "已确认", STALE: "已失效，需重新确认",
  ACTIVE: "有效", CURRENT: "当前有效", REVOKED: "已撤销",
  PASS: "检查通过", BLOCKED: "检查未通过", READY: "就绪", PENDING: "待处理",
  MISSING: "文件缺失", CORRUPT: "文件损坏", UNKNOWN: "未知", unknown: "未知", pending: "待返回",
  KNOWN: "已取得费用估算", LOW: "低风险", MEDIUM: "中等风险", HIGH: "高风险",
  HARD: "严格禁止修改", SOFT: "尽量保持不变",
  HOOK: "开场吸引注意", PAIN: "呈现用户痛点", PRODUCT: "引出产品",
  FEATURE: "展示功能卖点", PROOF: "提供可信证据", RESULT: "展示使用效果",
  CTA: "引导用户行动（如咨询、购买）", OTHER: "其他",
  NONE: "无", DIALOGUE: "人物对白", NARRATION: "旁白解说", AMBIENT: "有环境音",
  PARTIAL: "局部露出", CLEAR: "清晰展示", HERO: "产品主视觉",
  PLANNED: "已规划", GENERATING: "生成中", NEEDS_REVIEW: "待审片", ACTION_REQUIRED: "需要处理",
  ACCEPTED: "已接受", CREATED: "已创建，待提交", SUBMITTING: "正在提交", SUBMITTED: "已提交",
  PROCESSING: "处理中", SUCCEEDED: "生成成功", FAILED: "失败",
  SUBMISSION_OUTCOME_UNKNOWN: "提交结果未知，需核对", RECONCILING: "正在核对远端结果",
  RECONCILED_SUCCEEDED: "已核实生成成功", RECONCILED_FAILED: "已核实生成失败",
  ACCEPT: "接受此结果", REDO: "要求重做", SKIP: "跳过", USE: "恢复采用",
  UNVERIFIED: "尚未核实", VERIFIED: "已核验", REJECTED: "已排除", PROMOTED: "已确认为事实",
  logo: "品牌标识", color: "颜色", shape: "形状", packaging: "包装", text: "文字",
  model: "型号", proportion: "比例", other: "其他",
  PROBE: "检查生成服务", ACCOUNT: "检查账号", ESTIMATE: "估算费用", SUBMIT: "提交生成",
  STATUS: "查询状态", DOWNLOAD: "下载结果", RECONCILE: "核对提交结果",
  accountStatus: "账号状态检查", estimate: "费用估算", submit: "提交生成", status: "状态查询",
  download: "下载结果", reconcileSubmission: "核对提交结果",
  DREAMINA_NOT_FOUND: "未安装即梦命令行工具", PROVIDER_IDENTITY_UNVERIFIED: "即梦工具身份尚未核验",
  AUTHENTICATION_REQUIRED: "需要登录账号", INTERACTIVE_LOGIN_REQUIRED: "需要在官方页面登录",
  ENTITLEMENT_INSUFFICIENT: "账号权限或额度不足", CAPABILITY_UNSUPPORTED: "当前工具不支持此生成要求",
  COST_CONFIRMATION_REQUIRED: "需要确认生成费用", COST_ESTIMATE_UNKNOWN: "暂时无法估算费用，提交前需确认风险",
  SUBMISSION_RECONCILIATION_REQUIRED: "提交结果待核对，请勿直接重复提交",
  PROVIDER_CHANGED: "生成服务已变化，需重新检查与授权", ARTIFACT_INTEGRITY_FAILURE: "素材或结果文件完整性检查失败",
  ORPHAN_ARTIFACT_QUARANTINED: "未登记的文件已隔离，请核查", AUTH_REQUIRED: "需要账号授权",
  REFERENCE_ASSET_MISSING: "找不到参考素材，请重新上传",
  REFERENCE_ASSET_NOT_IMAGE: "参考素材不是图片，请选择产品图片",
  REFERENCE_ARTIFACT_NOT_READY: "参考图片尚未就绪或校验不一致，请重新上传",
  REFERENCE_ARTIFACT_PATH_INVALID: "参考图片路径无效，请重新上传",
  REFERENCE_ARTIFACT_MISSING: "参考图片文件已丢失，请重新上传",
  REFERENCE_ARTIFACT_HASH_MISMATCH: "参考图片内容已改变，请重新上传并确认",
  REFERENCE_IMAGE_TOO_SMALL: "参考图片太小，宽和高均须至少为 64 像素",
  REFERENCE_IMAGE_DECODE_FAILED: "无法读取参考图片，请换用正常的图片文件",
  NOT_CONFIGURED: "尚未配置", NOT_FOUND: "未找到所需内容", PROJECT_NOT_FOUND: "项目不存在",
  VALIDATION_ERROR: "填写内容不符合要求", INTERNAL_ERROR: "处理失败", ERROR: "操作失败",
  PREPARING: "准备中", RENDERING: "正在生成成片", UPLOADING: "上传中", PUBLISHING: "发布中",
  PUBLISHED: "已发布", PUBLISH_OUTCOME_UNKNOWN: "发布结果未知，请先核对抖音账号",
  UPLOADED: "已上传", AUTHENTICATED: "已登录", NOT_AUTHENTICATED: "尚未登录",
  PROVIDER_CHANGED_BEFORE_SUBMIT: "提交前检测到生成服务变化", PROVIDER_REPROBE_FAILED: "重新检测生成服务失败",
  SUBMIT_FAILED: "提交生成失败", STATUS_FAILED: "查询生成状态失败", DOWNLOAD_FAILED: "下载结果失败",
  RECONCILED_NOT_FOUND: "远端未找到该任务", RECONCILIATION_INCONCLUSIVE: "尚无法确认远端结果",
  RECONCILE_FAILED: "核对远端结果失败", DOUYIN_PUBLISH_FAILED: "抖音发布失败",
  RECOVERED_SUBMITTING_AFTER_RESTART: "重启后检测到未完成的提交，需核对结果",
  PRIMARY_PRODUCT: "产品主参考", LOGO: "品牌标识参考", STYLE: "风格参考", ENVIRONMENT: "环境参考", CHARACTER: "人物参考"
};

export function uiLabel(value: unknown): string {
  const key = String(value ?? "");
  return uiLabels[key] ?? key;
}

export const fieldLabels: Record<string, string> = {
  id: "标识", projectId: "项目标识", name: "项目名称", targetDurationMs: "目标时长（毫秒）",
  productName: "产品名称", featureDescription: "产品功能介绍", brand: "品牌", category: "类别",
  images: "产品图片", logo: "品牌标识", forbiddenChanges: "禁止修改项", severity: "约束程度", field: "约束对象",
  beats: "脚本段落", purpose: "用途", text: "文本", estimatedDurationMs: "预计时长（毫秒）",
  requiredFactIds: "引用的产品事实标识", segments: "镜头段落", scenes: "场景", clips: "视频片段",
  startMs: "开始时间（毫秒）", endMs: "结束时间（毫秒）", durationMs: "时长（毫秒）",
  shotSize: "景别", cameraPosition: "机位", cameraAngle: "角度", cameraMovement: "运镜", composition: "构图",
  subjectAction: "主体动作", productState: "产品状态", lighting: "灯光", dialogueOrNarration: "对白或旁白",
  ambientSound: "环境音", kind: "类型", description: "描述", continuityIn: "镜头开始的连续性状态",
  continuityOut: "镜头结束的连续性状态", environmentState: "环境状态", characterState: "人物状态",
  visualDirection: "视觉方向", soundDirection: "声音方向", productShowcaseRules: "产品展示规则",
  factId: "产品事实标识", sceneId: "场景标识", clipId: "视频片段标识", segmentId: "镜头段落标识",
  promptSection: "对应提示词段落", forbiddenChangeId: "禁止修改项标识", sourceBeatIds: "来源脚本段落标识",
  evidenceRef: "依据", dispositionConfirmedByUser: "已确认处理方式", stateHash: "状态校验值",
  estimatorVersion: "语音估时规则版本", requestHash: "请求校验值", approvalHash: "授权校验值"
};

/** Read-only inspection view. Never feed translated keys back into the API/compiler. */
export function localizedJson(value: unknown): string {
  function display(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(display);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, val]) => [fieldLabels[key] ?? key, display(val)]));
    }
    return item;
  }
  return JSON.stringify(display(value), null, 2);
}

const messages: Record<string, string> = {
  "provider.probe": "重新检测即梦生成工具",
  "provider.identity.verify": "核验即梦工具的官方来源与版本",
  "preflight.reference-assets": "检查并重新上传参考图片",
  "preflight.provider-capability": "检查生成工具是否支持所选模型和时长",
  "preflight.provider-refresh": "重新运行生成前检查并确认授权",
  "generation.reconcile": "核对远端任务状态与生成结果",
  "recovery.orphans": "核查已隔离的未登记文件",
  "recovery.artifacts": "恢复或重新上传缺失、损坏的文件",
  "publish.douyin.oauth": "配置抖音应用并重新连接抖音账号",
  "Request body too large": "上传内容过大，请减少素材数量或压缩文件后重试。",
  "Invalid JSON body": "提交的数据格式不正确，请刷新页面后重试。",
  "Body projectId must match URL project id": "提交的数据与当前项目不匹配，请刷新页面后重试。",
  "Uploaded file is empty": "上传的文件为空，请选择有内容的文件。",
  "Each uploaded file must be <= 10MB": "每个上传文件不能超过 10 MB，请压缩后重试。",
  "At least one product image is required": "请至少上传一张产品图片。",
  "Invalid upload payload": "上传的数据格式不正确，请重新选择图片。",
  "Only image uploads are allowed in P0": "当前步骤只支持上传图片，请选择产品图片或品牌标识图片。",
  "Uploaded artifact did not become READY": "上传文件未通过保存与完整性检查，请重新上传。",
  "Invalid ForbiddenChange field": "请选择有效的禁止修改对象。",
  "Invalid ForbiddenChange severity": "请选择“严格禁止修改”或“尽量保持不变”。",
  "No current ProductTruth to confirm": "尚无可确认的产品事实，请先上传资料并生成产品事实。",
  "UncertainClaim dispositions are required": "请先为每条待核实信息选择处理方式，再确认产品事实。",
  "No saved Product Input to retry": "尚未保存产品资料，请先填写并保存资料。",
  "Confirmed ProductTruth is required": "请先确认产品事实。",
  "creativeId is required": "请选择一个创意方案。",
  "Current ProductTruth and CreativeBatch are required": "请先生成产品事实与创意方案，并确认所选创意。",
  "Current ProductTruth, CreativeBatch and Script are required": "请先完成产品事实、创意和脚本步骤。",
  "Script revision requires beats": "修改脚本时至少需要一个脚本段落。",
  "No current ScriptDraft to revise": "尚无可修改的脚本，请先生成脚本。",
  "beat.requiredFactIds must be an array": "引用的产品事实标识格式不正确，请用英文逗号分隔多条标识。",
  "No current ProductionPlan to confirm": "尚无可确认的导演计划，请先生成计划。",
  "Saved Product Input is required": "请先保存产品资料和参考图片。",
  "Invalid OAuth state": "抖音授权校验失败，请从当前项目重新连接抖音账号。",
  "First segment must start at 0": "第一个镜头段落必须从 0 毫秒开始。",
  "Last segment must end at clip.durationMs": "最后一个镜头段落的结束时间必须等于该视频片段的总时长。",
  "First segment continuityIn must match clip openingState": "第一个镜头段落的开始状态必须与视频片段的开场状态一致。",
  "Last segment continuityOut must match clip closingState": "最后一个镜头段落的结束状态必须与视频片段的结尾状态一致。",
  "Segment endMs must be greater than startMs": "镜头段落的结束时间必须晚于开始时间。",
  "Segment order must be unique": "同一片段内的镜头段落序号不能重复。",
  "Speech duration exceeds segment duration": "预计语音时长超过镜头段落时长，请缩短对白或延长镜头。",
  "Segments must have no gap or overlap": "相邻镜头段落的时间必须首尾相接，不能留空或重叠。",
  "Adjacent segment continuity hashes must match": "相邻镜头的产品和环境状态不衔接，请检查前一镜头的结束状态与后一镜头的开始状态。",
  "Segment order must increase with time": "镜头段落序号必须按时间顺序递增。",
  "Unknown cost requires explicit user acceptance": "暂时无法确定本次费用，请先勾选接受费用未知风险，再确认生成授权。",
  "Unresolved submission outcome requires explicit duplicate-submission cost-risk acceptance before approval": "仍有提交结果尚未核实；若要创建新任务，请先明确接受可能重复扣费的风险。",
  "At least one accepted Clip is required before continuing with a partial selection": "至少需要接受一个视频片段，才能使用部分片段进入成片步骤。",
  "Review clip is not in current ProductionPlan": "此视频片段不属于当前导演计划，请刷新页面后重新选择。",
  "ReviewDecision must target the current latest successful output for this Clip": "只能审核该片段当前最新一次成功生成的视频，请刷新后重新审片。",
  "Confirmed ProductTruth requires user-confirmed claim disposition": "确认产品事实前，必须逐条确认待核实信息的处理方式。",
  "CreativeConcept ids must be unique within batch": "同一组创意方案的标识不能重复，请重新生成创意。",
  "selectedCreativeId must belong to batch": "所选创意不属于当前方案，请重新选择。",
  "No current ProductionPlan to revise": "尚无可修改的导演计划，请先生成计划。",
  "ProductionPlan revision requires segments array": "导演计划修改必须包含镜头段落，请检查编辑内容。",
  "beat.estimatedDurationMs must be an integer": "脚本段落的预计时长必须填写整数，单位为毫秒。",
  "Project name is required": "请填写项目名称。",
  "Product name and feature description are required": "请填写产品名称和产品功能介绍。",
  "Product Input requires at least one reference image": "请至少上传一张产品参考图片。",
  "Current ProductionPlan is required": "请先生成并确认导演计划。",
  "Current ProductTruth is not confirmed": "请先确认当前产品事实。",
  "Current ScriptDraft is not confirmed": "请先确认当前脚本。",
  "Creative generation requires CONFIRMED ProductTruth": "请先确认产品事实，再生成创意。",
  "Script generation requires CONFIRMED ProductTruth": "请先确认产品事实，再生成脚本。",
  "Script generation requires ACTIVE CreativeBatch": "请先生成并选择当前有效的创意。",
  "No current CreativeBatch": "当前没有创意方案，请先生成创意。",
  "Current CreativeBatch is missing or stale": "当前创意方案不存在或已失效，请重新生成创意。",
  "Selected creative does not belong to current batch": "所选创意不属于当前方案，请刷新页面后重新选择。",
  "ProductTruth must be CONFIRMED before Creative": "请先确认产品事实，再进入创意步骤。",
  "ScriptDraft must be CONFIRMED before Director": "请先确认脚本，再生成导演计划。",
  "ProductionPlan must be CONFIRMED before Preflight": "请先确认导演计划，再运行生成前检查。",
  "Only DRAFT ProductTruth can be confirmed": "只能确认草稿状态的产品事实，请刷新页面查看当前版本。",
  "Only DRAFT ScriptDraft can be confirmed": "只能确认草稿状态的脚本，请刷新页面查看当前版本。",
  "Only DRAFT ProductionPlan can be confirmed": "只能确认草稿状态的导演计划，请刷新页面查看当前版本。",
  "No CURRENT GenerationRequest to approve": "当前没有可授权的生成请求，请先运行生成前检查。",
  "Approval chain is incomplete": "生成授权信息不完整，请重新运行生成前检查并确认授权。",
  "Preflight requires at least one current Clip": "当前计划至少需要一个视频片段，请检查导演计划。",
  "Preflight clipIds contain unknown or stale Clip ids": "所选片段不存在或已失效，请刷新页面后重新检查。",
  "Attempt has no provider handle": "此任务尚未取得远端任务编号，请先核对提交结果。",
  "Final video Artifact is not READY": "成片文件尚未就绪，请先生成成片并检查文件。",
  "Output video Artifact is not READY": "生成的视频文件尚未就绪，请先下载结果并检查文件。",
  "Successful attempt has no output Artifact": "远端已生成成功，但本地尚无结果文件，请下载结果。",
  "Douyin publish title is required": "请填写抖音发布标题。",
  "FFmpeg produced an empty final video": "成片输出为空，请检查源视频和成片日志后重试。",
  "Final video Artifact did not become READY": "成片文件未通过完整性检查，请重新生成成片。",
  "Hermes structured output was not valid standalone JSON": "智能生成返回的数据格式不正确。已保存的资料不会丢失，请重试生成。",
  "Hermes structured generation timed out": "智能生成超时。已保存的资料不会丢失，请稍后重试。",
  "Hermes returned empty structured output": "智能生成没有返回内容，请检查模型服务后重试。",
  "Failed to fetch": "连接本机服务失败，请确认工具已启动后重试。",
  "Load failed": "加载失败，请确认工具已启动后重试。",
  "fetch failed": "连接外部服务失败，请检查网络和账号配置后重试。"
};

export function uiMessage(value: unknown): string {
  const message = String(value ?? "").trim();
  if (!message) return "操作未完成，请刷新页面后重试。";
  if (messages[message]) return messages[message];
  if (uiLabels[message]) return uiLabels[message];
  if (/DOUYIN_CLIENT_KEY|Douyin OpenAPI is not configured/.test(message)) return "尚未配置抖音发布。请在本机配置中填写抖音应用标识、应用密钥和授权回调地址，并为应用开通视频发布权限。";
  if (/video\.create|OAuth|access_token/.test(message) && /[\u3400-\u9fff]/.test(message)) {
    return message.replace(/video\.create/g, "视频发布权限").replace(/OAuth/g, "账号").replace(/access_token/g, "访问凭据");
  }
  if (/AUTHENTICATION_REQUIRED:unknown/.test(message)) return "暂时无法确认登录状态，请检查网络并重新登录即梦。";
  const capability = message.match(/^CAPABILITY_UNSUPPORTED:(.+)$/);
  if (capability) {
    const feature = capability[1]!;
    if (feature === "duration-unknown") return "无法确认即梦支持的片段时长，请重新检测工具能力。";
    if (/^duration-\d+$/.test(feature)) return `即梦工具不支持当前片段时长（${Number(feature.slice(9)) / 1000} 秒），请调整导演计划。`;
    return `即梦工具暂不支持${uiLabel(feature)}，请核验工具版本及生成配置。`;
  }
  const reference = message.match(/^(REFERENCE_[A-Z_]+):/);
  if (reference && uiLabels[reference[1]!]) return uiLabels[reference[1]!]!;
  if (/Invalid ScriptBeat at index (\d+)/.test(message)) return `第 ${Number(message.match(/index (\d+)/)![1]) + 1} 个脚本段落的格式不正确，请检查用途、文本和时长。`;
  if (/^(productName|featureDescription) is required$/.test(message)) return `请填写${fieldLabels[message.split(" ")[0]!] ?? "必填内容"}。`;
  if (/^GenerationRequest already has ACTIVE UserApproval:/.test(message)) return "此生成请求已有有效授权，请使用现有任务，避免重复创建。";
  if (/^GenerationRequest has no current PreflightReport:/.test(message)) return "此生成请求尚未完成当前版本的生成前检查，请先运行检查。";
  if (/^Preflight must be PASS before approval:/.test(message)) return "生成前检查尚未通过，请先处理检查报告中的问题。";
  if (/^Attempt must be CREATED before submit/.test(message)) return "此任务已提交或状态已变化，请刷新任务状态，不要重复提交。";
  if (/^Attempt is not pollable:/.test(message)) return "此任务当前不处于可查询的提交或生成状态，请刷新页面。";
  if (/^Attempt is not downloadable:/.test(message)) return "此任务尚未生成成功，暂时不能下载结果。";
  if (/^Attempt is not reconcilable:/.test(message)) return "此任务当前无需核对提交结果，请刷新页面查看最新状态。";
  if (/^Only successful attempt can be reviewed/.test(message)) return "只能审核已成功生成的视频，请先等待任务完成并下载结果。";
  if (/Hermes structured generation failed/.test(message)) return "智能生成执行失败，请检查 Hermes 的模型配置、网络和账号状态后重试。";
  if (/ENOENT|not found:.*hermes|spawn hermes/i.test(message)) return "所需工具或文件不存在，请检查本机工具安装路径和素材文件。";
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "服务响应超时，请检查网络后重试；已提交的生成任务请先刷新状态，避免重复扣费。";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|network error/i.test(message)) return "服务连接失败，请检查网络及本机服务是否运行。";
  if (/Unexpected token|not valid JSON|JSON.*position|JSON.*end/i.test(message)) return "数据格式不正确，请刷新页面后重试；若再次出现，请检查服务日志。";
  if (/not current|ref mismatch|version ref mismatch|selectedCreativeId.*mismatch|upstream.*mismatch/i.test(message)) return "上游内容已更新，当前版本不再有效。请重新确认产品事实、创意、脚本和导演计划后再操作。";
  if (/Project not found/.test(message)) return "项目不存在，请返回项目列表重新选择。";
  if (/Attempt not found|GenerationAttempt not found/.test(message)) return "生成任务不存在，请刷新页面后重新选择。";
  if (/^Only DRAFT|requires DRAFT/.test(message)) return "只能修改或确认草稿版本，请刷新页面检查当前状态。";
  if (/must be READY|is not READY/.test(message)) return "所需文件尚未就绪，请检查素材或下载生成结果后重试。";
  if (/HARD ForbiddenChange/.test(message)) return "导演计划未完整保留严格禁止修改的产品要求，请修正计划后重试。";
  if (/reference.*(?:missing|image)|image.*(?:size|format|dimension)/i.test(message)) return "参考图片不符合生成要求，请检查图片文件、尺寸和格式后重新上传。";
  const coded = message.match(/^([A-Z][A-Z_]+)(?::(.*))?$/);
  if (coded && uiLabels[coded[1]!]) return uiLabels[coded[1]!]! + (coded[2] ? "，请检查对应片段或素材。" : "");
  if (/[\u3400-\u9fff]/.test(message)) {
    return message.replace(/Product Truth|ProductTruth/g, "产品事实").replace(/Production Plan|ProductionPlan/g, "导演计划")
      .replace(/Preflight/g, "生成前检查").replace(/GenerationAttempt|Attempt/g, "生成任务")
      .replace(/Artifact/g, "素材与结果文件").replace(/dreamina CLI/g, "即梦命令行工具")
      .replace(/CLI help\/capability/g, "命令行工具的帮助与能力信息").replace(/submit\/status\/download/g, "提交生成、状态查询和结果下载")
      .replace(/Clip/g, "视频片段").replace(/Prompt/g, "提示词").replace(/Approval/g, "生成授权")
      .replace(/\b(?:[A-Z][A-Z_]+)\b/g, token => uiLabels[token] ?? token);
  }
  return "操作未完成，请检查当前步骤的前置条件、素材和账号配置后重试；若仍失败，请联系维护人员检查服务。";
}

export function validationMessage(issues: readonly { code: string; path: PropertyKey[]; message: string; minimum?: unknown; maximum?: unknown; values?: unknown[] }[]): string {
  return issues.map(issue => {
    const field = issue.path.map(part => typeof part === "number" ? `第 ${part + 1} 项` : fieldLabels[String(part)] ?? "相关字段").join(" → ") || "填写内容";
    const reason = issue.code === "too_small" ? `内容不足或数值过小${issue.minimum !== undefined ? `（至少 ${issue.minimum}）` : ""}`
      : issue.code === "too_big" ? `内容过多或数值过大${issue.maximum !== undefined ? `（至多 ${issue.maximum}）` : ""}`
      : issue.code === "invalid_type" ? "内容缺失或类型不正确"
      : issue.code === "invalid_value" ? `请选择有效选项${issue.values ? `：${issue.values.map(uiLabel).join("、")}` : ""}`
      : issue.code === "invalid_format" ? "格式不正确"
      : uiMessage(issue.message);
    return `${field}：${reason}。`;
  }).join("\n");
}
