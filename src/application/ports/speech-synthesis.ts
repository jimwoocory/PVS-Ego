export type LocalSpeechVoice = { name: string; locale: string; enabled: boolean };
export interface SpeechSynthesisProvider {
  readonly id: string;
  voices(): Promise<LocalSpeechVoice[]>;
  synthesize(input: { text: string; voiceName: string; rate: number; outputPath: string }): Promise<void>;
}
