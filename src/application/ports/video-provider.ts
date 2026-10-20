import type { GenerationRequest } from "../../domain/schemas.js";

export type ProviderProbeResult =
  | {
      code: "DREAMINA_NOT_FOUND";
      cliFound: false;
      providerIdentityHash: string;
      capabilityFingerprint: string;
      rawStdout: string;
      rawStderr: string;
    }
  | {
      code: "PROVIDER_IDENTITY_UNVERIFIED";
      cliFound: true;
      executablePath: string;
      executableSha256: string;
      providerIdentityHash: string;
      capabilityFingerprint: string;
      rawStdout: string;
      rawStderr: string;
    }
  | {
      code: "READY";
      cliFound: true;
      identityVerified: true;
      executablePath: string;
      executableSha256: string;
      cliVersion: string;
      providerIdentityHash: string;
      supportedOperations: string[];
      supportedModels: string[];
      supportedDurationsMs?: number[];
      capabilityFingerprint: string;
      rawStdout: string;
      rawStderr: string;
    };

export type SubmitResult = {
  externalTaskId?: string;
  submitId?: string;
  opaqueHandle?: string;
};

export type GenerationHandle = SubmitResult;
export type AccountStatus = { status: "UNKNOWN" | "NOT_AUTHENTICATED" | "AUTHENTICATED"; availableCredits?: number };
export type CostEstimateResult = { status: "KNOWN" | "UNKNOWN"; estimatedCredits?: number; estimatedCostText?: string };
export type GenerationStatusResult = { status: "SUBMITTED" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" };
export type DownloadedAsset = { path: string; sha256: string; sizeBytes: number };
export type ReconcileResult =
  | { outcome: "FOUND_ACTIVE"; handle: GenerationHandle }
  | { outcome: "FOUND_SUCCEEDED"; handle: GenerationHandle }
  | { outcome: "FOUND_FAILED"; handle?: GenerationHandle; reason: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INCONCLUSIVE"; reason: string };

export type ProviderCommandOperation =
  | "PROBE"
  | "ACCOUNT"
  | "ESTIMATE"
  | "SUBMIT"
  | "STATUS"
  | "DOWNLOAD"
  | "RECONCILE";

export type ProviderCommandEvidence = {
  operation: ProviderCommandOperation;
  argvRedacted: string[];
  stdoutRedacted: string;
  stderrRedacted: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  timedOut: boolean;
};

export interface ProviderCommandEvidenceSource {
  drainCommandEvidence(
    operation?: ProviderCommandOperation
  ): ProviderCommandEvidence[];
}

export class SubmissionOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionOutcomeUnknownError";
  }
}

export interface VideoProvider {
  readonly id: "domestic-jimeng-cli";
  probe(): Promise<ProviderProbeResult>;
  accountStatus(): Promise<AccountStatus>;
  estimate(requests: GenerationRequest[]): Promise<CostEstimateResult>;
  submit(request: GenerationRequest): Promise<SubmitResult>;
  status(handle: GenerationHandle): Promise<GenerationStatusResult>;
  download(handle: GenerationHandle, outputPath: string): Promise<DownloadedAsset>;
  reconcileSubmission(input: {
    requestHash: string;
    submissionFingerprint: string;
    knownHandle?: GenerationHandle;
  }): Promise<ReconcileResult>;
  inspectCommandHelp?(command: string): Promise<{
    command: string;
    stdout: string;
    stderr: string;
    executablePath: string;
    executableSha256: string;
  }>;
}
