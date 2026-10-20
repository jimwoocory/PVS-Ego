import "../../isolation/require-isolation.js";
import path from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import type { SpeechSynthesisProvider, LocalSpeechVoice } from "../../application/ports/speech-synthesis.js";
import { AutoEditBlocked } from "../../domain/auto-edit.js";

// System-installed Windows voices only. No model, voice, font or binary is redistributed.
// API reference: https://learn.microsoft.com/dotnet/api/system.speech.synthesis.speechsynthesizer
const command = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$job=[Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if($job.action -eq 'voices') {
    $items=@($s.GetInstalledVoices() | ForEach-Object { @{ name=$_.VoiceInfo.Name; locale=$_.VoiceInfo.Culture.Name; enabled=$_.Enabled } })
    ConvertTo-Json -InputObject $items -Compress
  } elseif($job.action -eq 'synthesize') {
    $s.SelectVoice([string]$job.voiceName)
    $s.Rate=[int]$job.rate
    $s.SetOutputToWaveFile([string]$job.outputPath)
    $s.Speak([string]$job.text)
    $s.SetOutputToNull()
    '{"ok":true}'
  } else { throw 'Unsupported speech action' }
} finally { $s.Dispose() }
`;
const voicesSchema = z.array(z.object({ name: z.string().min(1), locale: z.string().min(1), enabled: z.boolean() }));

export class WindowsSpeechSynthesis implements SpeechSynthesisProvider {
  readonly id = "windows-system-speech-v1";
  private cache?: { at: number; voices: LocalSpeechVoice[] };
  private run(job: object): Promise<string> {
    if (process.platform !== "win32" || process.env.PVS_LOCAL_TTS_DISABLED === "1") {
      throw new AutoEditBlocked("LOCAL_SPEECH_UNAVAILABLE", "当前主机未启用本地语音，请提供旁白音频或保留原视频声音", true);
    }
    // Plain text and paths are passed as JSON on stdin, never interpolated into executable script/SSML.
    return new Promise((resolve, reject) => {
      const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = execFile(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(new AutoEditBlocked("LOCAL_SPEECH_FAILED", "本地语音合成失败：" + String(stderr || error.message).slice(-1200), true));
          else resolve(String(stdout).trim());
        });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(JSON.stringify(job));
    });
  }
  async voices(): Promise<LocalSpeechVoice[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.voices;
    const voices = voicesSchema.parse(JSON.parse(await this.run({ action: "voices" }))).filter(v => v.enabled);
    this.cache = { at: Date.now(), voices };
    return voices;
  }
  async synthesize(input: { text: string; voiceName: string; rate: number; outputPath: string }): Promise<void> {
    if (!input.text.trim() || input.text.length > 2000 || !Number.isInteger(input.rate) || input.rate < -2 || input.rate > 3) {
      throw new AutoEditBlocked("INVALID_NARRATION", "旁白文本或语速设置无效", true);
    }
    if (!(await this.voices()).some(v => v.name === input.voiceName)) throw new AutoEditBlocked("VOICE_UNAVAILABLE", "所选系统音色不可用，请重新选择", true);
    if (!path.isAbsolute(input.outputPath) || path.extname(input.outputPath).toLowerCase() !== ".wav") throw new Error("Internal speech output must be an absolute WAV path");
    await this.run({ action: "synthesize", ...input });
  }
}
