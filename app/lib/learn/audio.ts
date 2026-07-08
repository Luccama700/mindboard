// Pure PCM→WAV wrapping for Gemini TTS output (raw 16-bit little-endian PCM,
// 24 kHz mono). ~20 lines of header math keeps ffmpeg off Vercel entirely.

export const GEMINI_PCM_SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number = GEMINI_PCM_SAMPLE_RATE,
): Uint8Array {
  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);

  const wav = new Uint8Array(44 + pcm.length);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
}

export function pcmDurationSeconds(
  pcmBytes: number,
  sampleRate: number = GEMINI_PCM_SAMPLE_RATE,
): number {
  return Math.round(pcmBytes / ((sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8));
}
