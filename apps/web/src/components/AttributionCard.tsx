import {
  Card,
  CardContent,
  CardHeader,
  Chip,
  Grid,
  Typography,
} from '@mui/material';
import type { AttributionOkData } from '@aicorrection/shared';

/** 三栏归因卡片：错因 / 知识点 / 本质一句话；无作答时额外展示"本题讲解"三栏 */
export default function AttributionCard({
  attr,
}: {
  attr: AttributionOkData;
}) {
  const items = [
    ...(attr.correct_answer
      ? [{ label: '正确答案', value: attr.correct_answer, highlight: true }]
      : []),
    ...(attr.derivation
      ? [{ label: '正确推导', value: attr.derivation, highlight: false }]
      : []),
    ...(attr.pitfalls
      ? [{ label: '常见陷阱', value: attr.pitfalls, highlight: false }]
      : []),
    { label: '错因', value: attr.cause, highlight: false },
    { label: '知识点', value: attr.knowledge_point, highlight: false },
    { label: '本质一句话', value: attr.essence, highlight: false },
  ];
  return (
    <Grid container spacing={2}>
      {items.map((it, idx) => (
        <Grid item xs={12} key={it.label}>
          <Card
            variant="outlined"
            sx={it.highlight ? { borderColor: 'primary.main' } : undefined}
          >
            <CardHeader
              title={it.label}
              titleTypographyProps={{ variant: 'subtitle2' }}
              action={
                idx === 0 ? (
                  <Chip size="small" label={attr.attr_model_version} />
                ) : undefined
              }
            />
            <CardContent>
              <Typography
                variant="body1"
                sx={{ whiteSpace: 'pre-wrap' }}
              >
                {it.value}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}
