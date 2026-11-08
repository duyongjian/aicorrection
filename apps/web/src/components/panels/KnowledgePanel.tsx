/**
 * 知识管理面板：R17 自定义知识点 / R18 知识图谱（轻量 SVG 环形布局）。自包含。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../../api/client';
import type {
  CustomKpItem,
  KnowledgeGraphResponse,
} from '@aicorrection/shared';

interface Props {
  anonUserId: string;
}

export default function KnowledgePanel({ anonUserId }: Props) {
  const [customKps, setCustomKps] = useState<CustomKpItem[]>([]);
  const [newKp, setNewKp] = useState('');
  const [graph, setGraph] = useState<KnowledgeGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    if (!anonUserId) return;
    setLoading(true);
    setErr('');
    try {
      const [kps, g] = await Promise.all([
        api.listCustomKps(anonUserId),
        api.getKnowledgeGraph(anonUserId),
      ]);
      setCustomKps(kps.items);
      setGraph(g);
    } catch (e) {
      setErr((e as Error).message || '加载知识数据失败');
    } finally {
      setLoading(false);
    }
  }, [anonUserId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addCustomKp = async () => {
    if (!newKp.trim()) return;
    try {
      await api.createCustomKp({ anon_user_id: anonUserId, kp_text: newKp.trim() });
      setNewKp('');
      const kps = await api.listCustomKps(anonUserId);
      setCustomKps(kps.items);
    } catch (e) {
      setErr((e as Error).message || '新增自定义知识点失败');
    }
  };

  const graphLayout = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    const R = 120;
    const cx = 150;
    const cy = 150;
    const pos = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((n, i) => {
      const ang = (2 * Math.PI * i) / graph.nodes.length - Math.PI / 2;
      pos.set(n.kp_key, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
    });
    return { cx, cy, pos };
  }, [graph]);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        知识管理
      </Typography>
      {loading && <LinearProgress sx={{ mb: 1 }} />}

      {/* R17 自定义知识点 */}
      <Typography variant="subtitle2" color="text.secondary">
        自定义知识点（R17）
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
        <TextField size="small" label="新增知识点" value={newKp} onChange={(e) => setNewKp(e.target.value)} />
        <Button size="small" variant="contained" onClick={addCustomKp} disabled={!newKp.trim()}>
          添加
        </Button>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {customKps.length === 0 && <Typography variant="body2" color="text.secondary">暂无自定义知识点</Typography>}
        {customKps.map((k) => (
          <Chip key={k.kp_id} label={k.kp_text} color="secondary" variant="outlined" />
        ))}
      </Box>

      {/* R18 知识图谱 */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2 }}>
        知识图谱（R18 · 共现边=同错因聚类）
      </Typography>
      {graph && graph.nodes.length === 0 && (
        <Typography variant="body2" color="text.secondary">暂无图谱数据</Typography>
      )}
      {graphLayout && (
        <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
          <svg width={300} height={300} viewBox="0 0 300 300">
            {graph!.edges.map((e, i) => {
              const a = graphLayout.pos.get(e.source);
              const b = graphLayout.pos.get(e.target);
              if (!a || !b) return null;
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#90caf9" strokeWidth={Math.min(4, e.weight)} />
              );
            })}
            {graph!.nodes.map((n) => {
              const p = graphLayout.pos.get(n.kp_key)!;
              return (
                <g key={n.kp_key}>
                  <circle cx={p.x} cy={p.y} r={6} fill="#1976d2" />
                  <text x={p.x} y={p.y - 10} fontSize={11} textAnchor="middle" fill="#333">
                    {n.kp_text.length > 6 ? n.kp_text.slice(0, 6) + '…' : n.kp_text}
                  </text>
                </g>
              );
            })}
          </svg>
        </Box>
      )}

      <Box sx={{ mt: 2 }}>
        <Button size="small" variant="outlined" onClick={refresh} disabled={loading}>
          刷新
        </Button>
      </Box>

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}
    </Paper>
  );
}
