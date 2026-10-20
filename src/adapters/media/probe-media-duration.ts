import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";

export async function probeMediaDurationMs(
  filePath: string,
  executable = "ffprobe"
): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ],
      {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const seconds = Number(String(stdout ?? "").trim());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          resolve(undefined);
          return;
        }
        resolve(Math.round(seconds * 1000));
      }
    );
  });
}
