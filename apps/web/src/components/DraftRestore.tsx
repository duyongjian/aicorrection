import {
  Box,
  Button,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { SEGMENT_LABELS } from '@aicorrection/shared';
import type { Draft } from '../hooks/useDraft';

/** 断网草稿恢复列表 */
export default function DraftRestore({
  drafts,
  onRestore,
  onDelete,
}: {
  drafts: Draft[];
  onRestore: (d: Draft) => void;
  onDelete: (id: string) => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2">断网草稿（可恢复）</Typography>
      <List dense>
        {drafts.map((d) => (
          <ListItem
            key={d.id}
            secondaryAction={
              <IconButton
                edge="end"
                aria-label="delete"
                onClick={() => onDelete(d.id)}
              >
                <DeleteIcon />
              </IconButton>
            }
          >
            <ListItemText
              primary={`${SEGMENT_LABELS[d.segment]} · ${d.src_type}`}
              secondary={d.raw_text?.slice(0, 40) ?? d.image_name ?? '（图片草稿，恢复后需重拍）'}
            />
            <Button
              size="small"
              sx={{ mr: 1 }}
              onClick={() => onRestore(d)}
            >
              恢复
            </Button>
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
