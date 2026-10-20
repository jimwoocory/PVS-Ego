import "../../isolation/require-isolation.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { SecretStore } from "../../application/ports/secret-store.js";

type ProtectedSecretFile = {
  version: 1;
  scheme: "windows-dpapi-current-user";
  ciphertext: string;
};

function assertKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error("Invalid secret key");
  }
}

async function runPowerShellDpapi(
  mode: "protect" | "unprotect",
  input: string
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI secret store requires Windows");
  }
  const script =
    mode === "protect"
      ? [
          "$value=[Console]::In.ReadToEnd();",
          "$secure=ConvertTo-SecureString $value -AsPlainText -Force;",
          "$protected=ConvertFrom-SecureString $secure;",
          "[Console]::Out.Write($protected);"
        ].join("")
      : [
          "$value=[Console]::In.ReadToEnd().Trim();",
          "$secure=ConvertTo-SecureString $value;",
          "$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);",
          "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr));}",
          "finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr);}"
        ].join("");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script],
      {
        windowsHide: true,
        // A server started from PowerShell 7 inherits its module search path.
        // Windows PowerShell 5 must load its own Security module for DPAPI.
        env: {
          ...process.env,
          PSModulePath: path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32", "WindowsPowerShell", "v1.0", "Modules"
          )
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `DPAPI operation failed (exit ${code ?? "unknown"}): ${stderr.trim() || "unknown error"}`
          )
        );
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input, "utf8");
  });
}

export class WindowsDpapiSecretStore implements SecretStore {
  constructor(
    private readonly root = path.resolve(".runtime-secrets", "ai-providers")
  ) {}

  private filePath(key: string): string {
    assertKey(key);
    return path.join(this.root, key + ".json");
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.access(this.filePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    const file = this.filePath(key);
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as ProtectedSecretFile;
      if (
        raw.version !== 1 ||
        raw.scheme !== "windows-dpapi-current-user" ||
        typeof raw.ciphertext !== "string"
      ) {
        throw new Error("Unsupported protected secret format");
      }
      return await runPowerShellDpapi("unprotect", raw.ciphertext);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!value.trim()) throw new Error("Secret value cannot be empty");
    await fs.mkdir(this.root, { recursive: true });
    const ciphertext = (await runPowerShellDpapi("protect", value)).trim();
    const data: ProtectedSecretFile = {
      version: 1,
      scheme: "windows-dpapi-current-user",
      ciphertext
    };
    const file = this.filePath(key);
    const temp = file + ".tmp-" + process.pid;
    await fs.writeFile(temp, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(temp, file);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.filePath(key), { force: true });
  }
}
