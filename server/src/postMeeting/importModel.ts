export interface PreparedPostMeetingSource {
  source: 'upload' | 'feishu';
  externalRef: string;
  title: string;
  text: string;
  durationSec: number;
  recordedAt: Date | null;
  contentFingerprint: string;
}
