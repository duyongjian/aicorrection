import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { SEGMENTS, SEGMENT_LABELS, type Segment } from '@aicorrection/shared';
import { useLoop } from '../hooks/useLoop';
import { useDraft, type Draft } from '../hooks/useDraft';
import DraftRestore from '../components/DraftRestore';
import { describeError } from '../api/client';

/** R01 上传：拍照 / 文本 / 粘贴 + 草稿恢复（UPL-01） */
export default function UploadPage() {
  const navigate = useNavigate();
  const { upload, segment } = useLoop();
  const { drafts, loadDrafts, saveDraft, deleteDraft } = useDraft();

  const [seg, setSeg] = useState<Segment>(segment ?? 'kaoyan');
  const [srcType, setSrcType] = useState<'photo' | 'text' | 'paste'>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  const submit = async (): Promise<void> => {
    setError(null);
    if (srcType === 'photo' && !file) {
      setError('请先选择或拍摄一张题目照片');
      return;
    }
    if (srcType !== 'photo' && !text.trim()) {
      setError('请先输入或粘贴题目内容');
      return;
    }
    setBusy(true);
    try {
      await upload({
        segment: seg,
        src_type: srcType,
        raw_text: srcType === 'photo' ? undefined : text,
        imageFile: srcType === 'photo' ? file ?? undefined : undefined,
        subject: 'math',
        retry_count: 0,
        photo_blur: false,
        upload_duration_ms: 800,
      });
      navigate('/attr');
    } catch (e) {
      setError(`${describeError(e)}（草稿已暂存，可恢复后重试）`);
      const draft: Draft = {
        id: 'd_' + Date.now().toString(36),
        segment: seg,
        src_type: srcType,
        raw_text: srcType === 'photo' ? undefined : text,
        retry_count: 0,
        photo_blur: false,
        upload_duration_ms: 800,
        image_name: file?.name,
        created_at: new Date().toISOString(),
      };
      await saveDraft(draft);
    } finally {
      setBusy(false);
    }
  };

  const restore = (d: Draft): void => {
    setSeg(d.segment);
    setSrcType(d.src_type);
    setText(d.raw_text ?? '');
    setFile(null);
  };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        上传一道错题
      </Typography>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <FormControl fullWidth size="small">
            <InputLabel id="seg-label">学段</InputLabel>
            <Select
              labelId="seg-label"
              label="学段"
              value={seg}
              onChange={(e) => setSeg(e.target.value as Segment)}
            >
              {SEGMENTS.map((s) => (
                <MenuItem key={s} value={s}>
                  {SEGMENT_LABELS[s]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth size="small">
            <InputLabel id="src-label">提交方式</InputLabel>
            <Select
              labelId="src-label"
              label="提交方式"
              value={srcType}
              onChange={(e) =>
                setSrcType(e.target.value as 'photo' | 'text' | 'paste')
              }
            >
              <MenuItem value="text">文本输入</MenuItem>
              <MenuItem value="paste">粘贴</MenuItem>
              <MenuItem value="photo">拍照 / 图片</MenuItem>
            </Select>
          </FormControl>

          {srcType === 'photo' ? (
            <Button variant="outlined" component="label">
              选择 / 拍摄照片
              <input
                hidden
                accept="image/*"
                capture="environment"
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Button>
          ) : (
            <TextField
              multiline
              minRows={4}
              label={srcType === 'paste' ? '粘贴题目' : '输入题目'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}

          {error && <Alert severity="warning">{error}</Alert>}

          <Button
            variant="contained"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? '提交中…' : '提交并归因'}
          </Button>
        </Stack>
      </Paper>

      <DraftRestore
        drafts={drafts}
        onRestore={restore}
        onDelete={(id) => void deleteDraft(id)}
      />
    </Box>
  );
}
