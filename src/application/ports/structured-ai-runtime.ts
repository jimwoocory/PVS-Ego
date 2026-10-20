import type { AiStep } from "./ai-settings-repository.js";

export type StructuredAiRequest = {
  task: string;
  instructions: string;
  input: unknown;
  outputContract: unknown;
  media?: Array<
    | {
        type: "image";
        mimeType: "image/jpeg" | "image/png" | "image/webp";
        dataBase64: string;
        label?: string;
      }
    | {
        type: "audio";
        mimeType: "audio/mpeg" | "audio/wav";
        dataBase64: string;
        label?: string;
      }
  >;
  context?: {
    projectId: string;
    step: AiStep;
  };
};

export type StructuredAiExecutionMetadata = {
  executionId: string;
  providerId: string;
  modelId: string;
  configVersion: number;
};

export type StructuredAiResult = {
  data: unknown;
  metadata?: StructuredAiExecutionMetadata;
};

export interface StructuredAiRuntime {
  readonly id: string;
  readonly version: string;
  generateJson(request: StructuredAiRequest): Promise<unknown>;
  generateJsonWithMetadata?(
    request: StructuredAiRequest
  ): Promise<StructuredAiResult>;
}

export async function generateStructuredJson(
  runtime: StructuredAiRuntime,
  request: StructuredAiRequest
): Promise<StructuredAiResult> {
  if (runtime.generateJsonWithMetadata) {
    return runtime.generateJsonWithMetadata(request);
  }
  return { data: await runtime.generateJson(request) };
}
