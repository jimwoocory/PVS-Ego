import type {
  PublishProviderMode,
  PublishProviderProbeCode,
  PublishProviderType
} from "../../domain/publish.js";
import type { PublishPlatformIdentity } from "../../domain/publish.js";

export type PublishProviderProbe = {
  providerType: PublishProviderType;
  displayName: string;
  mode: PublishProviderMode;
  code: PublishProviderProbeCode;
  reason?: string;
  accountDisplayName?: string;
  platformUserId?: string;
  supportsTrustedFinalConfirmation: boolean;
  requiresMobileDevice: boolean;
  complianceNotice?: string;
};

export type PublishHandoffInput = {
  projectId: string;
  packageId: string;
  title: string;
  description?: string;
  bridgeUrl: string;
  videoUrl: string;
};

export type PublishHandoffResult = {
  launchUrl?: string;
  handoffReference?: string;
  instruction: string;
  awaitingUserAction: boolean;
};

export type PublishDirectInput = {
  projectId: string;
  packageId: string;
  videoPath: string;
  title: string;
  description?: string;
  expectedAccountId?: string;
  browserPreparedSession?: {binding:import("./browser-publish-preparation.js").BrowserPageBinding;scope:import("./browser-publish-preparation.js").BrowserPublishScope};
};

export type PublishDirectResult = {
  trusted: true;
  externalReference: string;
  videoId?: string;
  itemId?: string;
  platformIdentity?: PublishPlatformIdentity;
};

export class PublishSubmissionUnknownError extends Error {
  readonly externalReference?: string;

  constructor(message: string, externalReference?: string) {
    super(message);
    this.name = "PublishSubmissionUnknownError";
    this.externalReference = externalReference;
  }
}

export interface PublishProvider {
  readonly type: PublishProviderType;
  readonly displayName: string;
  readonly mode: PublishProviderMode;
  probe(projectId: string): Promise<PublishProviderProbe>;
  prepareHandoff?(
    input: PublishHandoffInput
  ): Promise<PublishHandoffResult>;
  directPublish?(
    input: PublishDirectInput
  ): Promise<PublishDirectResult>;
}
