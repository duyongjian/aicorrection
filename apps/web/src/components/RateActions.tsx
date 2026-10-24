import { Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { INACCURATE_REASONS } from '@aicorrection/shared';
import type { InaccurateReason, RateAction } from '@aicorrection/shared';

const REASON_LABELS: Record<InaccurateReason, string> = {
  not_essence: '未触及本质',
  wrong_knowledge: '知识点错误',
  wrong_cause: '错因错误',
  other: '其他',
};

/** 认可 / 不准确（含不准确原因选择）。attr_dislike 已废除，统一 rate_action='inaccurate'。 */
export default function RateActions({
  onRate,
}: {
  onRate: (action: RateAction, reason?: InaccurateReason) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'inaccurate'>('idle');
  const [reason, setReason] = useState<InaccurateReason>('not_essence');

  if (mode === 'idle') {
    return (
      <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
        <Button
          variant="contained"
          color="success"
          onClick={() => onRate('approve')}
        >
          认可
        </Button>
        <Button
          variant="outlined"
          color="warning"
          onClick={() => setMode('inaccurate')}
        >
          不准确
        </Button>
      </Stack>
    );
  }

  return (
    <Box sx={{ mt: 3 }}>
      <Stack spacing={2}>
        <Typography variant="subtitle2">请选择不准确原因：</Typography>
        <TextField
          select
          size="small"
          value={reason}
          onChange={(e) => setReason(e.target.value as InaccurateReason)}
        >
          {INACCURATE_REASONS.map((r) => (
            <MenuItem key={r} value={r}>
              {REASON_LABELS[r]}
            </MenuItem>
          ))}
        </TextField>
        <Stack direction="row" spacing={2}>
          <Button
            variant="contained"
            color="warning"
            onClick={() => onRate('inaccurate', reason)}
          >
            提交不准确
          </Button>
          <Button onClick={() => setMode('idle')}>取消</Button>
        </Stack>
      </Stack>
    </Box>
  );
}
