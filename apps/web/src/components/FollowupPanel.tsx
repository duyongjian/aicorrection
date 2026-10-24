import {
  Box,
  Button,
  Alert,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { FollowupResponse } from '@aicorrection/shared';

interface Msg {
  role: 'user' | 'ai';
  content: string;
  hasNext?: boolean;
}

/** 追问交互流（限 1 次有效）：用户提问 → AI 补充归因；达上限提示"已达当前追问深度"。 */
export default function FollowupPanel({
  onFollowup,
  seqStart = 4,
}: {
  onFollowup: (message: string, seq: number) => Promise<FollowupResponse>;
  seqStart?: number;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [seq, setSeq] = useState(seqStart);
  const [busy, setBusy] = useState(false);
  const [canAsk, setCanAsk] = useState(true);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy || !canAsk) return;
    setBusy(true);
    const curSeq = seq;
    setMsgs((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    try {
      const data = await onFollowup(text, curSeq);
      setMsgs((m) => [
        ...m,
        { role: 'ai', content: data.content, hasNext: data.has_next_action },
      ]);
      setCanAsk(data.has_next_action);
      setSeq((s) => s + 1);
    } catch {
      setMsgs((m) => [...m, { role: 'ai', content: '追问失败，请稍后重试' }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        追问（补充归因）
      </Typography>
      <Stack spacing={1}>
        {msgs.map((m, i) => (
          <Paper
            key={i}
            elevation={0}
            sx={{
              p: 1.5,
              bgcolor: m.role === 'user' ? 'primary.light' : 'grey.100',
              color: m.role === 'user' ? 'primary.contrastText' : 'text.primary',
            }}
          >
            <Typography variant="body2">{m.content}</Typography>
          </Paper>
        ))}
      </Stack>

      {!canAsk && (
        <Alert severity="info" sx={{ mt: 2 }}>
          已达当前追问深度。建议回去做一道同类题巩固（验证环节将在 v0.2 开放）。
        </Alert>
      )}

      {canAsk && (
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <TextField
            fullWidth
            size="small"
            placeholder="还有哪一点没想通？"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            disabled={busy}
          />
          <Button
            variant="contained"
            onClick={() => void send()}
            disabled={busy}
          >
            追问
          </Button>
        </Stack>
      )}
    </Box>
  );
}
