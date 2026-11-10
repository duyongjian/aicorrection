import { useEffect, useRef, useState, type ChangeEvent } from 'react';
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
import { useLoop } from '../hooks/useLoop';
import { useDraft, type Draft } from '../hooks/useDraft';
import DraftRestore from '../components/DraftRestore';
import { describeError } from '../api/client';
import { tracker } from '../tracking/sdk';

/** 文件大小自适应格式化：<1MB 用 KB，否则 MB，均保留 1 位小数。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 将图片文件读为 data: URL（base64）。相比 URL.createObjectURL 生成的 blob: URL，
 *  data: 被 helmet 默认 CSP 的 img-src 'self' data: 允许，可被 <img> 直接渲染，
 *  从而避免预览被 CSP 拦截（"照片预览加载失败"）。 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('readAsDataURL failed'));
    reader.readAsDataURL(file);
  });
}

/** R01 上传：拍照 / 文本 / 粘贴 + 草稿恢复（UPL-01） */
export default function UploadPage() {
  const navigate = useNavigate();
  const { upload, segment } = useLoop();
  const { drafts, loadDrafts, saveDraft, deleteDraft } = useDraft();

  // 学段不再由用户逐题选择：沿用账号学段（持久化在 localStorage），无记录时兜底为 kaoyan。
  // 该字段后端仍要求，但对归因/分析 prompt 无影响，故不再作为上传页摩擦项。
  const seg = segment ?? 'kaoyan';
  const [srcType, setSrcType] = useState<'photo' | 'text'>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 从草稿恢复时若草稿含图片名（但图片本身不落草稿），提示用户重新选择。 */
  const [draftImageHint, setDraftImageHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  /** 防止异步预解码结果错位：每次选图自增序号，过期的检测丢弃。 */
  const fileSeqRef = useRef(0);
  /** 图片无法在浏览器预览（HEIC/不支持格式/损坏）时的温和提示，文件仍保留可提交。 */
  const [heicNote, setHeicNote] = useState(false);

  useEffect(() => {
    void loadDrafts();
    // T2: screen_view 埋点 — 上传页
    tracker.screenView('upload');
  }, [loadDrafts]);

  // 卸载时释放尚未撤销的预览 URL，避免内存泄漏
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  /** 清空 input 的 value，否则再次选择同一文件不会触发 onChange。 */
  const resetInput = (): void => {
    if (inputRef.current) inputRef.current.value = '';
  };

  const removePhoto = (): void => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setFile(null);
    setPreviewUrl(null);
    setHeicNote(false);
    resetInput();
  };

  /** 选图/拍照后的校验 + 预览生成。
   *  用 createImageBitmap 真解码探测：能解码才渲染预览；不能解码（HEIC / 不支持格式 /
   *  损坏文件，含扩展名/MIME 被伪装的 iPhone 实拍图）则温和提示「可继续提交」，
   *  彻底避免「照片预览加载失败，请重新选择或拍摄」这类阻断性报错。 */
  const onFileChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0] ?? null;
    setDraftImageHint(null);
    setHeicNote(false);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (!f) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    const type = (f.type || '').toLowerCase();
    const name = (f.name || '').toLowerCase();
    const looksImage =
      type.startsWith('image/') ||
      /\.(heic|heif)$/.test(name) ||
      /heic|heif/.test(type);
    // accept="image/*" 仅为建议，浏览器不强制拦截，这里显式校验文件类型
    if (!looksImage) {
      setError('请选择图片文件（jpg / png / webp 等）');
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    setFile(f);
    const seq = ++fileSeqRef.current;
    try {
      // 真解码探测：浏览器解码不了会抛错，此时不强渲染、改温和提示
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(f);
        bmp.close();
      }
      if (seq !== fileSeqRef.current) return; // 用户已重新选择，丢弃过期结果
      // 用 data: URL 而非 blob:，规避 helmet 默认 CSP 对 blob: 图片的拦截
      const url = await readFileAsDataUrl(f);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch {
      if (seq !== fileSeqRef.current) return;
      // 预览不可用，但文件仍保留、可正常提交（后端 OCR 会给出识别结果或失败提示）
      setHeicNote(true);
      setPreviewUrl(null);
    }
  };

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
    // 历史草稿可能存了 paste 类型（早期版本），合并后统一归为 text
    setSrcType(d.src_type === 'paste' ? 'text' : d.src_type);
    setText(d.raw_text ?? '');
    // 草稿不存图片（既有设计），保持置空；若有图片名则提示需重新拍摄/选择
    setFile(null);
    resetInput();
    setDraftImageHint(
      d.image_name ? `草稿不含图片，请重新拍摄/选择（原图：${d.image_name}）` : null
    );
  };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        上传一道错题
      </Typography>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <FormControl fullWidth size="small">
            <InputLabel id="src-label">提交方式</InputLabel>
            <Select
              labelId="src-label"
              label="提交方式"
              value={srcType}
              onChange={(e) =>
                setSrcType(e.target.value as 'photo' | 'text')
              }
            >
              <MenuItem value="text">文本输入 / 粘贴</MenuItem>
              <MenuItem value="photo">拍照 / 图片</MenuItem>
            </Select>
          </FormControl>

          {srcType === 'photo' ? (
            <Stack spacing={1.5}>
              {/* 隐藏的原生文件输入，由下方按钮触发；单实例避免 ref 冲突 */}
              <input
                ref={inputRef}
                hidden
                accept="image/*"
                capture="environment"
                type="file"
                onChange={onFileChange}
              />
              <Button
                variant="outlined"
                onClick={() => inputRef.current?.click()}
              >
                {file ? '重新选择照片' : '选择 / 拍摄照片'}
              </Button>

              {file && (
                <Box>
                  {heicNote ? (
                    <Alert severity="info" sx={{ mb: 1 }}>
                      该图片当前浏览器无法直接预览，但可正常提交；若后端识别失败，可在结果页改用文本入口补充题目。
                    </Alert>
                  ) : previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="照片预览"
                      onError={() => setHeicNote(true)}
                      style={{
                        maxWidth: '100%',
                        maxHeight: 240,
                        borderRadius: 4,
                        border: '1px solid rgba(0,0,0,0.12)',
                        display: 'block',
                        marginBottom: 8,
                      }}
                    />
                  ) : null}
                  <Typography variant="body2" color="text.secondary">
                    {file.name}（{formatFileSize(file.size)}）
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => inputRef.current?.click()}
                    >
                      重新选择
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      color="error"
                      onClick={removePhoto}
                    >
                      移除照片
                    </Button>
                  </Stack>
                </Box>
              )}

              {draftImageHint && (
                <Alert severity="info">{draftImageHint}</Alert>
              )}
            </Stack>
          ) : (
            <TextField
              multiline
              minRows={4}
              label="输入或粘贴题目"
              placeholder="可直接键入，也可 Ctrl/Cmd+V 粘贴题目文字"
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
