export type PublicApiError = {
  error: string;
  message: string;
};

export function publicApiError(error: unknown): PublicApiError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (
    name === "StructuredAiRuntimeError" ||
    name === "OpenAiCompatibleError" ||
    /Hermes structured generation|OpenAI-compatible|chat completions/i.test(message)
  ) {
    if (/timed out|timeout|ETIMEDOUT|aborted/i.test(message)) {
      return {
        error: "AI_GENERATION_TIMEOUT",
        message:
          "大模型生成超时，请重试。如果持续发生，请到“大模型设置”检查当前模型和超时时间。"
      };
    }
    return {
      error: "AI_GENERATION_FAILED",
      message:
        "大模型生成失败，请重试。如果持续发生，请到“大模型设置”或“系统诊断”检查当前模型连接。"
    };
  }

  return {
    error: "INTERNAL_ERROR",
    message:
      "操作失败，请重试。如果问题持续存在，请查看“系统诊断”或开启“高级信息”检查原因。"
  };
}
