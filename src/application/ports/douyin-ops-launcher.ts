export type DouyinOpsLaunchResult = {
  ok: boolean;
  status: "STARTED" | "UNAVAILABLE" | "FAILED";
  message: string;
};

export interface DouyinOpsLauncher {
  launch(): Promise<DouyinOpsLaunchResult>;
}
