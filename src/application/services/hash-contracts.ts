import { hashValue } from "../../domain/hashing.js";
import type { GenerationRequest, UserApproval } from "../../domain/schemas.js";

export function computeCompiledPromptHash(input: {
  compilerTemplateVersion: string;
  normalizedInput: unknown;
  promptText: string;
}): string {
  return hashValue(input);
}

export function computeGenerationRequestHash(
  request: Omit<GenerationRequest, "requestHash">
): string {
  return hashValue(request);
}

export function computeApprovalHash(
  approval: Omit<UserApproval, "approvalHash">
): string {
  return hashValue(approval);
}
