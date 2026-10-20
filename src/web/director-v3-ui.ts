import type { SmartGenerationRun } from "../domain/smart-generation.js";
import { renderClipReviewForPrompt, renderClipReviewFinalization, type WorkflowInlineData } from "./workflow-inline-panels.js";
import { auditNarrativeTiming, isScriptDurationWithinTolerance } from "../application/services/script-narrative-timing.js";
import { extractV8DialogueLines, compileV8ShotShadow } from "../application/services/v8-shot-prompt-shadow.js";
import { planV8ShotFirstShadow } from "../application/services/v8-shot-first-shadow.js";
import { buildV8ScreenplayShadow } from "../application/services/v8-screenplay-shadow.js";
import { renderClipAssetBindingPreview } from "./clip-reference-bindings-ui.js";

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]!
  );
}

function lines(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

function editable(run: SmartGenerationRun): boolean {
  return (
    run.options.directorVersion === 3 &&
    !run.pendingInstall &&
    run.attemptIds.length === 0 &&
    ![
      "GENERATION",
      "CLIP_REVIEW",
      "AUTO_EDIT",
      "RENDER",
      "FINAL_REVIEW",
      "DONE"
    ].includes(run.stage)
  );
}

export function renderDirectorV3Panels(
  run: SmartGenerationRun,
  reviewData?: WorkflowInlineData
): string {
  if (run.options.directorVersion !== 3) return "";
  const canEdit = editable(run);
  const promptReview = Boolean(reviewData && run.status === "WAITING_FOR_CLIP_REVIEW");
  const timingAudit = run.script ? auditNarrativeTiming(run.script) : null;
  const needsNarrativeRevision = Boolean(timingAudit && (
    timingAudit.issues.some(issue => issue.severity === "REVISE") ||
    !isScriptDurationWithinTolerance(run.script!.targetDurationMs, timingAudit.totalMs)
  ));
  const scriptPanel = run.script
    ? `<details class="v3-panel" ${promptReview ? "" : "open"}>
        <summary><b>① 剧本 · Director V3</b></summary>
        <p class="muted">先改故事和动作逻辑。每段时长根据对白、动作与必要反应决定，绝不机械均分；整个故事可以比用户目标短或长 10%。保存剧本后，旧分镜、Seedance Prompt、生成前检查及费用范围全部失效；产品事实与制作资产仍保留。</p>
        ${timingAudit ? '<p class="muted">用户目标 '+(run.script!.targetDurationMs/1000)+' 秒，允许 '+(timingAudit.allowedMinMs/1000)+'–'+(timingAudit.allowedMaxMs/1000)+' 秒；当前剧情预计 '+(timingAudit.totalMs/1000)+' 秒。</p>' : ''}
        ${needsNarrativeRevision && timingAudit
          ? '<p class="error" role="status">当前剧本重新审核发现节奏或叙事问题：'+timingAudit.issues.map(issue=>esc(issue.message)).join('；')+'。旧版 QA 显示通过也不能直接据此付费出片。</p>'
          : ''}
        ${canEdit && needsNarrativeRevision
          ? '<button class="secondary" data-action="repair-script-v3">按剧情重新编排剧本与时长（AI 文本修订）</button><p class="muted">仅在你点击并确认后调用文本模型；保留原剧本历史，修订完成后需重新审核剧本，不会自动付费生成图片或视频。</p>'
          : ''}
        ${timingAudit ? '<details><summary>查看逐段对白与动作估时依据</summary>'+timingAudit.beats.map(item=>'<p class="muted">Beat '+item.order+' · 编排 '+(item.assignedMs/1000)+'s · 白话朗读下限估计 '+(item.estimatedSpeechMs/1000).toFixed(1)+'s · 动作下限估计 '+(item.estimatedActionMs/1000).toFixed(1)+'s'+(item.sceneChanged?' · 有场景切换':'')+'</p>').join('')+'</details>' : ''}
        ${
          run.scriptFeasibility
            ? `<p class="${
                run.scriptFeasibility.status === "PASS" && !needsNarrativeRevision
                  ? "ok"
                  : "error"
              }">可生成性检查：${
                run.scriptFeasibility.status === "PASS" && !needsNarrativeRevision
                  ? "通过"
                  : "需要修改"
              } · Beat ${
                run.scriptFeasibility.metrics.beatCount
              } · 动作 ${
                run.scriptFeasibility.metrics.detectedActionCount
              } · 场景切换 ${
                run.scriptFeasibility.metrics.detectedSceneTransitionCount
              }</p>`
            : ""
        }
        <div class="v3-script-list">
          ${run.script.beats
            .map((beat) => {
              const intent = beat.videoIntent;
              return `<article class="v3-script-beat"
                data-beat-id="${esc(beat.id)}"
                data-order="${beat.order}"
                data-purpose="${esc(beat.purpose)}"
                data-duration="${beat.estimatedDurationMs}"
                data-required-facts="${esc(
                  beat.requiredFactIds.join(",")
                )}">
                <h4>Beat ${beat.order} · ${esc(
                  beat.purpose
                )} · ${beat.estimatedDurationMs / 1000} 秒</h4>
                <label>预计段落时长（秒）<input type="number" class="v3-editor v3-script-duration" min="1" max="120" step="0.1" value="${beat.estimatedDurationMs / 1000}" ${canEdit ? "" : "readonly"}></label>
                <label>剧情内容<textarea class="v3-editor v3-script-text" ${
                  canEdit ? "" : "readonly"
                }>${esc(beat.text)}</textarea></label>
                <div class="row">
                  <label class="field">场景<input class="v3-editor v3-script-location" value="${esc(
                    intent?.location ?? ""
                  )}" ${canEdit ? "" : "readonly"}></label>
                  <label class="field">主要故事动作<input class="v3-editor v3-script-action" value="${esc(
                    intent?.storyAction ?? ""
                  )}" ${canEdit ? "" : "readonly"}></label>
                </div>
                <div class="row">
                  <label class="field">产品在本段的作用<input class="v3-editor v3-script-product-role" value="${esc(
                    intent?.productRole ?? ""
                  )}" ${canEdit ? "" : "readonly"}></label>
                  <label class="field">开始状态<input class="v3-editor v3-script-state-in" value="${esc(
                    intent?.stateIn ?? ""
                  )}" ${canEdit ? "" : "readonly"}></label>
                  <label class="field">结束状态<input class="v3-editor v3-script-state-out" value="${esc(
                    intent?.stateOut ?? ""
                  )}" ${canEdit ? "" : "readonly"}></label>
                </div>
                <div class="row">
                  <label class="field">产品结构开始状态<input class="v3-editor v3-script-product-state-in" value="${esc(
                    intent?.productStateIn ?? ""
                  )}" ${canEdit ? "" : "readonly"} placeholder="例如：完整成品，外罩闭合"></label>
                  <label class="field">产品结构结束状态<input class="v3-editor v3-script-product-state-out" value="${esc(
                    intent?.productStateOut ?? ""
                  )}" ${canEdit ? "" : "readonly"} placeholder="结构不变时与开始状态相同"></label>
                </div>
                <div class="row">
                  <label class="field">人物对白（没有就留空）<textarea class="v3-editor v3-script-dialogue" ${
                    canEdit ? "" : "readonly"
                  }>${esc(intent?.dialogue ?? "")}</textarea></label>
                  <label class="field">OS 旁白（没有就留空）<textarea class="v3-editor v3-script-os" ${
                    canEdit ? "" : "readonly"
                  }>${esc(intent?.os ?? "")}</textarea></label>
                </div>
                <div class="row">
                  <label class="field">自然环境声（每行一项）<textarea class="v3-editor v3-script-ambience" ${
                    canEdit ? "" : "readonly"
                  }>${esc(lines(intent?.audioIntent.ambience))}</textarea></label>
                  <label class="field">交互声 / 音效（每行一项）<textarea class="v3-editor v3-script-sfx" ${
                    canEdit ? "" : "readonly"
                  }>${esc(lines(intent?.audioIntent.sfx))}</textarea></label>
                </div>
                <label>后期文字（每行一条，不让 Seedance 生成文字）<textarea class="v3-editor v3-script-post-text" ${
                  canEdit ? "" : "readonly"
                }>${esc(lines(intent?.postProductionText))}</textarea></label>
              </article>`;
            })
            .join("")}
        </div>
        ${
          canEdit
            ? '<button data-action="script-v3">保存剧本修改并重做下游分镜</button>'
            : '<p class="muted">当前任务已经进入真实生成或下游阶段，本轮导演内容只读；如需重构请新建一轮。</p>'
        }
      </details>`
    : "";

  const formalClips =
    run.productionPlan?.scenes.flatMap((scene) =>
      scene.clips.map((clip) => ({ scene, clip }))
    ) ?? [];

  const storyboardPanel =
    run.directorV3Plan && formalClips.length
      ? `<details class="v3-panel" ${promptReview ? "" : "open"}>
          <summary><b>② 分镜 · Clip Contract</b></summary>
          <p class="muted">这里决定每段视频只做什么。修改某一段后会重新生成正式分镜与 Seedance Prompt，但不会改剧本。</p>
          ${run.directorV3Plan.clipContracts
            .map((contract, index) => {
              const formal = formalClips[index];
              if (!formal) return "";
              return `<article class="v3-storyboard" data-clip-id="${esc(
                formal.clip.id
              )}">
                <h4>视频 ${index + 1} · ${
                  contract.durationMs / 1000
                } 秒</h4>
                <label>本段视频目标<textarea class="v3-editor v3-purpose" ${
                  canEdit ? "" : "readonly"
                }>${esc(contract.purpose)}</textarea></label>
                <label>场景<input class="v3-editor v3-location" value="${esc(
                  contract.location
                )}" ${canEdit ? "" : "readonly"}></label>
                <h5>动作时间线</h5>
                ${contract.actions
                  .map(
                    (action) =>
                      `<label>${action.startMs / 1000}–${
                        action.endMs / 1000
                      } 秒<textarea class="v3-editor v3-action-text" ${
                        canEdit ? "" : "readonly"
                      }>${esc(action.description)}</textarea></label>`
                  )
                  .join("")}
                <div class="row">
                  <label class="field">景别<input class="v3-editor v3-camera-shot" value="${esc(
                    contract.camera.shotSize
                  )}" ${canEdit ? "" : "readonly"}></label>
                  <label class="field">机位<input class="v3-editor v3-camera-position" value="${esc(
                    contract.camera.position
                  )}" ${canEdit ? "" : "readonly"}></label>
                  <label class="field">角度<input class="v3-editor v3-camera-angle" value="${esc(
                    contract.camera.angle
                  )}" ${canEdit ? "" : "readonly"}></label>
                  <label class="field">运镜<input class="v3-editor v3-camera-movement" value="${esc(
                    contract.camera.movement
                  )}" ${canEdit ? "" : "readonly"}></label>
                </div>
                <div class="row">
                  <label class="field">环境声（每行一项）<textarea class="v3-editor v3-audio-ambience" ${
                    canEdit ? "" : "readonly"
                  }>${esc(lines(contract.audio.ambience))}</textarea></label>
                  <label class="field">交互声 / 音效（每行一项）<textarea class="v3-editor v3-audio-sfx" ${
                    canEdit ? "" : "readonly"
                  }>${esc(lines(contract.audio.sfx))}</textarea></label>
                </div>
                <div class="row">
                  <label class="field">对白（每行一条）<textarea class="v3-editor v3-audio-dialogue" ${
                    canEdit ? "" : "readonly"
                  }>${esc(
                    lines(
                      contract.audio.dialogueOrOs
                        .filter(
                          (item) =>
                            item.kind === "DIALOGUE"
                        )
                        .map((item) => item.text)
                    )
                  )}</textarea></label>
                  <label class="field">OS（每行一条）<textarea class="v3-editor v3-audio-os" ${
                    canEdit ? "" : "readonly"
                  }>${esc(
                    lines(
                      contract.audio.dialogueOrOs
                        .filter((item) => item.kind === "OS")
                        .map((item) => item.text)
                    )
                  )}</textarea></label>
                </div>
                <p class="muted">声音策略：保留 Seedance 原生环境声 / 交互声 / 音效 / 对白 / OS；BGM 禁止。</p>
                ${
                  canEdit
                    ? '<button data-action="storyboard-v3">保存此分镜并重做本段下游</button>'
                    : ""
                }
              </article>`;
            })
            .join("")}
        </details>`
      : "";

  // The current Director ClipId is authoritative. A generated video must
  // never be paired with a prompt just because their array indices coincide.
  const savedPrompts = run.seedancePromptDrafts ?? [];
  const promptRows = promptReview && formalClips.length
    ? formalClips.map(({ clip }, index) => ({
        clipId: clip.id,
        order: index + 1,
        durationMs: clip.durationMs,
        draft: savedPrompts.find(draft => draft.clipId === clip.id)
      }))
    : savedPrompts.map((draft, index) => ({
        clipId: draft.clipId,
        order: index + 1,
        durationMs: formalClips.find(item => item.clip.id === draft.clipId)?.clip.durationMs,
        draft
      }));
  const promptPanel = promptRows.length
    ? `<details class="v3-panel" id="v3-seedance-workbench-${esc(run.id)}" open>
        <summary><b>③ 最终 Seedance Prompt${promptReview ? " · 视频与审片" : ""}</b></summary>
        <p class="muted">${promptReview
          ? "已生成的视频与对应提示词放在同一处。先播放核对画面与声音；需要查看生成提示词时再展开。修改旧文本不会覆盖已经生成的视频。"
          : "这是实际送给 Seedance 的提示词。只改这里不会改变剧本和分镜；保存后只重新跑生成前检查。"}</p>
        ${promptRows.map(({ clipId, order, durationMs, draft }) => {
          const hasReadyVideo = Boolean(reviewData?.attempts?.some(attempt =>
            attempt.clipId === clipId &&
            ["SUCCEEDED", "RECONCILED_SUCCEEDED"].includes(attempt.status) &&
            Boolean(attempt.outputArtifactId) &&
            reviewData.artifacts?.some(artifact =>
              artifact.id === attempt.outputArtifactId &&
              artifact.projectId === run.projectId &&
              artifact.integrityStatus === "READY" &&
              artifact.mimeType === "video/mp4"
            )
          ));
          const videoReview = promptReview && reviewData
            ? renderClipReviewForPrompt(reviewData, clipId) : "";
          const boundClip = formalClips.find(item => item.clip.id === clipId)?.clip;
          const references = boundClip ? renderClipAssetBindingPreview({clip:boundClip,assetSet:run.productionAssetSet}) : "";
          return `<article class="v3-prompt" data-clip-id="${esc(clipId)}" id="v3-video-${order}">
              <h4>视频 ${order}${durationMs ? " · " + durationMs / 1000 + " 秒" : ""}</h4>
              ${videoReview}
              ${references}
              <details class="v3-prompt-details" ${hasReadyVideo ? "" : "open"}>
                <summary>${hasReadyVideo ? "展开查看本视频生成提示词" : "本视频生成提示词"}</summary>
                ${draft
                  ? `<textarea class="v3-editor v3-prompt-text" maxlength="12000" ${canEdit ? "" : "readonly"}>${esc(draft.promptText)}</textarea>`
                  : '<p class="error">此镜头没有匹配的已保存生成提示词；请核查分镜和提示词版本，不会借用其他镜头文本。</p>'}
                ${canEdit && draft ? '<button data-action="prompt-v3">保存此 Prompt</button>' : ""}
              </details>
            </article>`;
        }).join("")}
        ${promptReview && reviewData ? renderClipReviewFinalization(reviewData) : ""}
      </details>`
    : "";

  // V8 lives alongside V3 in read-only SHADOW mode. It never adopts a plan,
  // overrides paid approval, or invokes a provider.
  let v8ShadowPanel = "";
  if (run.script && run.productionPlan) {
    const report = compileV8ShotShadow({
      script: run.script,
      plan: run.productionPlan,
      ...(run.directorV3Plan ? { director: run.directorV3Plan } : {}),
      ...(run.productionAssetSet ? { productionAssetSet: run.productionAssetSet } : {})
    });
    const capabilities = run.productionPlan.generationTarget?.operationConstraints
      ?.filter(item => item.operation === "text2video" || item.operation === "multimodal2video") ?? [];
    const mins = capabilities.flatMap(item => item.durationMinSeconds === undefined ? [] : [item.durationMinSeconds]);
    const maxes = capabilities.flatMap(item => item.durationMaxSeconds === undefined ? [] : [item.durationMaxSeconds]);
    const preview = mins.length && maxes.length
      ? planV8ShotFirstShadow({
          script: run.script,
          modelMinSeconds: Math.max(...mins),
          modelMaxSeconds: Math.min(...maxes)
        })
      : undefined;
    const screenplay = buildV8ScreenplayShadow(run.script);
    const actors = (run.productionAssetSet?.entries ?? [])
      .filter(entry => entry.kind === "CHARACTER" && entry.status === "READY");
    const speakers = [...new Set(run.script.beats.flatMap(
      beat => extractV8DialogueLines(beat.videoIntent?.dialogue ?? "").map(line => line.speaker)
    ))];
    const selections = speakers.map(speaker =>
      '<label>剧本说话者“' + esc(speaker) + '”对应的已确认角色' +
      '<select data-v8-speaker="' + esc(speaker) + '">' +
      '<option value="">请确认对应角色</option>' +
      actors.map(actor => '<option value="' + esc(actor.key) + '">' + esc(actor.label) + '</option>').join("") +
      '</select></label>'
    ).join("");
    const blockerCount = report.issues.filter(issue => issue.level === "BLOCKER").length;
    v8ShadowPanel = '<details class="v3-panel v8-shadow-preview" data-v8-project="' +
      esc(run.projectId) + '" data-v8-run="' + esc(run.id) + '">' +
      '<summary><b>④ 剧本—分镜—提示词对照（只读预览，不影响当前任务）</b></summary>' +
      '<p class="muted">原正式 V3 分镜和付费范围完全保留。本预览仅检查，不能直接用于扣费生成。</p>' +
      '<p><b>原方案：</b>' + report.clips.map(item => item.durationMs / 1000 + ' 秒').join(' + ') +
      '；<b>Shot-first 备选：</b>' +
      (preview ? preview.clips.map(item => item.durationMs / 1000 + ' 秒').join(' + ') : '模型时长能力未验证') + '</p>' +
      '<p>详细剧本源数据检测：' + screenplay.scenes.length + ' 场、' +
        screenplay.transcribedBeatCount + ' 个剧情节拍、' + screenplay.dialogueLineCount +
        ' 句台词。未提供的演员目标、语气或揭晓时机不会由程序猜测。</p>' +
      '<p>旧分镜逐镜检查：' + (blockerCount ? blockerCount + ' 项需修复或确认' : '无阻断项') +
      '。原台词映射 ' + report.coverage.mappedDialogueCount + '/' +
      report.coverage.sourceDialogueCount + '；后期文字 ' +
      report.coverage.mappedTextCount + '/' + report.coverage.requiredTextCount + '。</p>' +
      (report.issues.length
        ? '<details><summary>具体差异与遗漏</summary>' +
          report.issues.map(issue => '<p class="muted">' + esc(issue.message) + '</p>').join("") + '</details>'
        : '') +
      '<div class="v8-speaker-selections">' + selections + '</div>' +
      '<p class="muted">角色绑定只影响此次只读预览，不会保存为正式剧本/分镜身份。确认后可查看逐镜提示词，不进行模型调用。</p>' +
      '<button type="button" class="secondary" data-v8-refresh>检查并预览逐镜提示词</button>' +
      '<div class="v8-shadow-result" role="status" aria-live="polite"></div>' +
      '</details>';
  }
  return scriptPanel + storyboardPanel + promptPanel + v8ShadowPanel;
}