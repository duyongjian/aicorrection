/**
 * 知识管理面板：R17 自定义知识点 / R18 知识图谱（轻量 SVG 环形布局）。自包含。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  KpMistakeItem,
} from '@aicorrection/shared';

interface Props {
  anonUserId: string;
}

interface SelectedKp {
  kp_key: string;
  kp_text: string;
}

export default function KnowledgePanel({ anonUserId }: Props) {
  const navigate = useNavigate();
  const [customKps, setCustomKps] = useState<CustomKpItem[]>([]);
  const [newKp, setNewKp] = useState('');
  const [graph, setGraph] = useState<KnowledgeGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [selectedKp, setSelectedKp] = useState<SelectedKp | null>(null);
  const [mistakes, setMistakes] = useState<KpMistakeItem[]>([]);
  const [mistakesLoading, setMistakesLoading] = useState(false);
  const [mistakesErr, setMistakesErr] = useState('');

  // 两段数据独立加载：即使 custom_kp / knowledge_graph 权益配置不一致，也不互相拖垮。
  const refresh = useCallback(async () => {
    if (!anonUserId) return;
    setLoading(true);
    setErr('');
    const errors: string[] = [];
    try {
      const kps = await api.listCustomKps(anonUserId);
      setCustomKps(kps.items);
    } catch (e) {
      errors.push((e as Error).message || '加载自定义知识点失败');
    }
    try {
      const g = await api.getKnowledgeGraph(anonUserId);
      setGraph(g);
    } catch (e) {
      errors.push((e as Error).message || '加载知识图谱失败');
    }
    if (errors.length) setErr(errors.join('；'));
    setLoading(false);
  }, [anonUserId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setSelectedKp(null);
  }, [anonUserId]);

  // 点击节点 → 下钻该知识点的错题；切换身份或取消选中时清空。
  useEffect(() => {
    if (!selectedKp) {
      setMistakes([]);
      setMistakesErr('');
      setMistakesLoading(false);
      return;
    }
    let cancelled = false;
    setMistakes([]);
    setMistakesErr('');
    setMistakesLoading(true);
    api
      .listKpMistakes(anonUserId, selectedKp.kp_key)
      .then((res) => {
        if (!cancelled) setMistakes(res.items);
      })
      .catch((e: Error) => {
        if (!cancelled) setMistakesErr(e.message || '加载该知识点错题失败');
      })
      .finally(() => {
        if (!cancelled) setMistakesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [anonUserId, selectedKp]);

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
      <Typography variant="caption" color="text.secondary">
        点击节点查看该知识点错题，再次点击取消选中
      </Typography>
      {graph && graph.nodes.length === 0 && (
        <Typography variant="body2" color="text.secondary">暂无图谱数据</Typography>
      )}
      {graphLayout && (
        <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
          <svg width={300} height={300} viewBox="0 0 300 300" role="img" aria-label="知识点共现图">
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
              const active = selectedKp?.kp_key === n.kp_key;
              return (
                <g
                  key={n.kp_key}
                  onClick={() =>
                    setSelectedKp((prev) =>
                      prev?.kp_key === n.kp_key ? null : { kp_key: n.kp_key, kp_text: n.kp_text }
                    )
                  }
                  style={{ cursor: 'pointer' }}
                  aria-label={`查看 ${n.kp_text} 的错题`}
                >
                  <title>{`${n.kp_text}（${n.error_count} 次错误）`}</title>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={active ? 9 : 6}
                    fill={active ? '#f57c00' : '#1976d2'}
                    stroke={active ? '#e65100' : 'none'}
                    strokeWidth={active ? 3 : 0}
                  />
                  <text
                    x={p.x}
                    y={p.y - 12}
                    fontSize={11}
                    textAnchor="middle"
                    fill={active ? '#e65100' : '#333'}
                    fontWeight={active ? 700 : 400}
                  >
                    {n.kp_text.length > 6 ? n.kp_text.slice(0, 6) + '…' : n.kp_text}
                  </text>
                </g>
              );
            })}
          </svg>
        </Box>
      )}

      {/* R18 节点下钻：选中知识点的错题列表 */}
      {selectedKp && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2">
            「{selectedKp.kp_text}」相关错题
            <Button size="small" onClick={() => setSelectedKp(null)} sx={{ ml: 1 }}>
              收起
            </Button>
          </Typography>
          {mistakesLoading && <LinearProgress sx={{ my: 1 }} />}
          {mistakesErr && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {mistakesErr}
            </Alert>
          )}
          {!mistakesLoading && !mistakesErr && mistakes.length === 0 && (
            <Typography variant="body2" color="text.secondary">该知识点下暂无错题</Typography>
          )}
          {!mistakesErr &&
            mistakes.map((m) => (
              <Paper
                key={m.attribution_id}
                variant="outlined"
                onClick={() => navigate(`/history/${m.loop_id}`)}
                sx={{ mt: 1, p: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
              >
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                  {m.question?.trim() || '（无题目快照）'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  错因：{m.cause || '未标注'} · {m.created_at}
                </Typography>
              </Paper>
            ))}
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
