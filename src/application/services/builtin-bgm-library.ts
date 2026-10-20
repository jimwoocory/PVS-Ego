export type BuiltinBgmDefinition = {
  key: "warm-story" | "light-product" | "calm-craft";
  label: string;
  filename: string;
  bpm: number;
  seed: number;
  progression: number[];
  energy: number;
};

export const BUILTIN_BGM_LIBRARY: BuiltinBgmDefinition[] = [
  {
    key: "warm-story",
    label: "内置原创 · 温暖叙事",
    filename: "warm-story-v1.wav",
    bpm: 84,
    seed: 17,
    progression: [57, 53, 60, 55],
    energy: 0.72
  },
  {
    key: "light-product",
    label: "内置原创 · 轻快产品",
    filename: "light-product-v1.wav",
    bpm: 108,
    seed: 29,
    progression: [60, 55, 57, 53],
    energy: 0.9
  },
  {
    key: "calm-craft",
    label: "内置原创 · 克制工艺",
    filename: "calm-craft-v1.wav",
    bpm: 72,
    seed: 43,
    progression: [50, 53, 57, 55],
    energy: 0.55
  }
];

export function builtinBgmArtifactId(projectId: string, key: BuiltinBgmDefinition["key"]): string {
  return projectId + "-builtin-bgm-" + key + "-v1";
}

const midiHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const clamp16 = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));

function noise(sampleIndex: number, seed: number): number {
  let x = (sampleIndex + seed * 2654435761) >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return ((x >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * Deterministic original instrumental bed used only as a safe starter library.
 * It contains no vocals and no third-party samples. The 60-second file is long
 * enough for the common 10-60s short-video workflow without any mid-video loop.
 */
export function renderBuiltinBgmWav(def: BuiltinBgmDefinition): Buffer {
  const sampleRate = 24_000;
  const durationSeconds = 60;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = sampleRate * durationSeconds;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = sampleCount * channels * bytesPerSample;
  const out = Buffer.allocUnsafe(44 + dataBytes);

  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  out.writeUInt16LE(channels * bytesPerSample, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);

  const secondsPerBeat = 60 / def.bpm;
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const beat = t / secondsPerBeat;
    const bar = Math.floor(beat / 4);
    const beatInBar = beat - bar * 4;
    const root = def.progression[bar % def.progression.length]!;
    const third = root + (bar % 2 === 0 ? 4 : 3);
    const fifth = root + 7;
    const octave = root + 12;

    const slowPulse = 0.76 + 0.24 * Math.sin(2 * Math.PI * (def.bpm / 60 / 4) * t);
    const pad =
      Math.sin(2 * Math.PI * midiHz(root) * t) * 0.075 +
      Math.sin(2 * Math.PI * midiHz(third) * t) * 0.055 +
      Math.sin(2 * Math.PI * midiHz(fifth) * t) * 0.05;
    const bass = Math.sin(2 * Math.PI * midiHz(root - 12) * t) * 0.075;

    const eighth = beat * 2;
    const eighthIndex = Math.floor(eighth);
    const eighthPhase = eighth - eighthIndex;
    const arpNotes = [root + 12, third + 12, fifth + 12, octave + 7];
    const arpNote = arpNotes[eighthIndex % arpNotes.length]!;
    const arpEnv = Math.exp(-4.8 * eighthPhase);
    const arp = Math.sin(2 * Math.PI * midiHz(arpNote) * t) * 0.055 * arpEnv;

    const quarterPhase = beat - Math.floor(beat);
    const kickEnv = Math.exp(-16 * quarterPhase);
    const kick = Math.sin(2 * Math.PI * (52 + 28 * kickEnv) * t) * 0.055 * kickEnv;

    const hatEnv = Math.exp(-38 * eighthPhase);
    const hat = noise(i, def.seed) * 0.012 * hatEnv;

    const phrase = Math.sin(2 * Math.PI * midiHz(octave) * t) * 0.018 *
      (0.5 + 0.5 * Math.sin(2 * Math.PI * (def.bpm / 60 / 8) * t));

    const fadeIn = Math.min(1, t / 0.7);
    const fadeOut = Math.min(1, (durationSeconds - t) / 0.9);
    const master = Math.max(0, Math.min(fadeIn, fadeOut));
    const value = (pad * slowPulse + bass + arp + kick + hat + phrase) * def.energy * master;
    out.writeInt16LE(clamp16(value), 44 + i * 2);
  }

  return out;
}
