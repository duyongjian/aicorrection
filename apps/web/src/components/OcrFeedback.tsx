import { Alert } from '@mui/material';
import type { OcrStatus } from '@aicorrection/shared';

/** OCR fail / partial 引导重拍或文本兜底 */
export default function OcrFeedback({ ocrStatus }: { ocrStatus: OcrStatus }) {
  if (ocrStatus === 'fail') {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        未检测到题目或图片识别失败，请上传含题目的清晰照片，或改用文本 / 粘贴入口提交题目。
      </Alert>
    );
  }
  if (ocrStatus === 'partial') {
    return (
      <Alert severity="warning" sx={{ mb: 2 }}>
        图片识别不完整（占位题干）。建议改用文本入口补充题目，以获得准确归因。
      </Alert>
    );
  }
  return null;
}
