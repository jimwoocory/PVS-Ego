import type {
  PublishProvider,
  PublishProviderProbe
} from "../ports/publish-provider.js";
import type { PublishProviderType } from "../../domain/publish.js";
import { DomainValidationError } from "../../domain/validation.js";

export class PublishProviderRegistry {
  private readonly providers = new Map<PublishProviderType, PublishProvider>();

  constructor(providers: PublishProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.type)) {
        throw new Error("Duplicate PublishProvider: " + provider.type);
      }
      this.providers.set(provider.type, provider);
    }
  }

  get(type: PublishProviderType): PublishProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new DomainValidationError(
        "PublishProvider is not registered: " + type
      );
    }
    return provider;
  }

  async probes(projectId: string): Promise<PublishProviderProbe[]> {
    return Promise.all(
      [...this.providers.values()].map((provider) =>
        provider.probe(projectId)
      )
    );
  }

  types(): PublishProviderType[] {
    return [...this.providers.keys()];
  }
}
