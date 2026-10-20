export type ProductionImageKind =
  | "CHARACTER"
  | "SET"
  | "PROP"
  | "PRODUCT_STATE"
  | "STYLE";

export type ProductionImageSubmitInput = {
  projectId: string;
  businessKey: string;
  requestHash: string;
  kind: ProductionImageKind;
  prompt: string;
  referenceImagePaths?: string[];
};

export type ProductionImageSubmitResult = {
  submitId: string;
};

export type ProductionImageStatusResult =
  | {
      status: "SUBMITTED" | "PROCESSING";
      observation?: "QUEUE_FINISHED_WITHOUT_RESULT";
    }
  | { status: "SUCCEEDED"; imageUrl: string }
  | { status: "FAILED"; reason?: string }
  | { status: "UNKNOWN"; reason?: string };

export interface ProductionImageProvider {
  readonly id: string;
  probe(): Promise<{
    ready: boolean;
    providerVersion?: string;
    reason?: string;
  }>;
  submit(input: ProductionImageSubmitInput): Promise<ProductionImageSubmitResult>;
  status(submitId: string): Promise<ProductionImageStatusResult>;
  download(imageUrl: string, outputPath: string): Promise<{
    path: string;
    sha256: string;
    sizeBytes: number;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
  }>;
}
