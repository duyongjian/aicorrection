import {
  Card,
  CardContent,
  CardHeader,
  Chip,
  Grid,
  Typography,
} from '@mui/material';
import type { AttributionOkData } from '@aicorrection/shared';

/** 三栏归因卡片：错因 / 知识点 / 本质一句话 */
export default function AttributionCard({
  attr,
}: {
  attr: AttributionOkData;
}) {
  const items = [
    { label: '错因', value: attr.cause },
    { label: '知识点', value: attr.knowledge_point },
    { label: '本质一句话', value: attr.essence },
  ];
  return (
    <Grid container spacing={2}>
      {items.map((it) => (
        <Grid item xs={12} key={it.label}>
          <Card variant="outlined">
            <CardHeader
              title={it.label}
              titleTypographyProps={{ variant: 'subtitle2' }}
              action={
                <Chip size="small" label={attr.attr_model_version} />
              }
            />
            <CardContent>
              <Typography variant="body1">{it.value}</Typography>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}
