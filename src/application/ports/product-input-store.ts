import type { AssetRef, ForbiddenChange } from "../../domain/schemas.js";

export type ProductInputSnapshot = {
  id: string;
  projectId: string;
  version: number;
  productName: string;
  featureDescription: string;
  brand?: string;
  category?: string;
  assets: AssetRef[];
  forbiddenChanges: ForbiddenChange[];
  contentHash: string;
  createdAt: string;
};

export interface ProductInputStore {
  save(input: Omit<ProductInputSnapshot, "id" | "version" | "contentHash" | "createdAt">): Promise<ProductInputSnapshot>;
  latest(projectId: string): Promise<ProductInputSnapshot | null>;
}
