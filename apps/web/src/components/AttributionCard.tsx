import {
  Card,
  CardContent,
  CardHeader,
  Chip,
  Divider,
  Grid,
  Link,
  Box,
  Typography,
} from '@mui/material';
import type { AttributionOkData, AttributionWebSearch } from '@aicorrection/shared';
import MathText from './MathText';

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
              <MathText text={it.value ?? ''} />
            </CardContent>
          </Card>
        </Grid>
      ))}

      {/* 联网搜索参考块（P2）：仅当用户显式开启且命中时填充；仅供参考，须独立验证。 */}
      {attr.webSearch && attr.webSearch.status === 'ok' && attr.webSearch.items.length > 0 && (
        <Grid item xs={12}>
          <Divider sx={{ my: 1 }}>
            网络依据（仅供参考，须独立验证）
          </Divider>
          <Card variant="outlined" sx={{ borderColor: 'warning.main' }}>
            <CardHeader
              title="联网搜索参考"
              titleTypographyProps={{ variant: 'subtitle2' }}
            />
            <CardContent>
              {attr.webSearch.items.map((it, i) => (
                <Box key={i} sx={{ mb: 1 }}>
                  <Link href={it.url} target="_blank" rel="noreferrer">
                    {it.title}
                  </Link>
                  {it.snippet && (
                    <Typography variant="body2" color="text.secondary">
                      {it.snippet}
                    </Typography>
                  )}
                </Box>
              ))}
            </CardContent>
          </Card>
        </Grid>
      )}
    </Grid>
  );
}
