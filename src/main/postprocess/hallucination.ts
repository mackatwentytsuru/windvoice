// Whisper-family models emit stock "outro" phrases for near-silent audio
// (training data is full of video subtitles). When the ENTIRE take is one of
// them, it is almost certainly not what the user said — drop it rather than
// paste it. Partial matches inside real dictation are left alone.
// List after Sharrnah/whispering's ignorelist.

const PHRASES = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  'ご清聴ありがとうございました',
  '最後までご視聴いただきありがとうございます',
  '最後までご視聴いただきありがとうございました',
  'チャンネル登録よろしくお願いします',
  'チャンネル登録お願いします',
  'チャンネル登録をお願いします',
  'thank you for watching',
  'thanks for watching',
  'please subscribe'
];

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s。、．，,.!！?？…・「」『』"'（）()]/g, '');

const NORMALIZED = new Set(PHRASES.map(normalize));

export function isSilenceHallucination(text: string): boolean {
  const n = normalize(text);
  return n.length > 0 && NORMALIZED.has(n);
}
