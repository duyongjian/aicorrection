/**
 * 知识点与错因服务（P2：R17 自定义知识点 / R20 手动错因 / R18 知识图谱）。
 * 与 aggregationService（R09/R10/R14）解耦：此处偏"用户主动编辑/查看"，
 * 改动会触发聚合重算（R20 改了 kp → 重算新旧两处掌握度）。
 */
import { HttpError } from '../middleware/errorHandler';
import { ERROR_CODES, CAUSE_TAXONOMY } from '@aicorrection/shared';
import type {
  CreateCustomKpRequest,
  CreateCustomKpResponse,
  CustomKpListResponse,
  ManualCauseRequest,
  ManualCauseResponse,
  KnowledgeGraphResponse,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
} from '@aicorrection/shared';
import {
  insertCustomKp,
  getCustomKps,
} from '../models/customKpModel';
import {
  patchAttributionCause,
  getAttributionByLoopForUser,
  getAttributionsKpCause,
} from '../models/attributionModel';
import { recomputeMastery } from './aggregationService';

// ----------------- R17 自定义知识点 -----------------

export function createCustomKp(req: CreateCustomKpRequest): CreateCustomKpResponse {
  if (!req.anon_user_id || !req.anon_user_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  if (!req.kp_text || req.kp_text.trim().length < 1) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '知识点文本不能为空');
  }
  const kp = insertCustomKp({
    anon_user_id: req.anon_user_id,
    kp_text: req.kp_text.trim(),
    parent_kp_key: req.parent_kp_key ?? null,
  });
  return { kp_id: kp.kp_id, kp_text: kp.kp_text, parent_kp_key: kp.parent_kp_key };
}

export function listCustomKps(anon_user_id: string): CustomKpListResponse {
  if (!anon_user_id || !anon_user_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  const items = getCustomKps(anon_user_id);
  return { anon_user_id, items };
}

// ----------------- R20 手动错因标记 -----------------

export function setManualCause(req: ManualCauseRequest): ManualCauseResponse {
  if (!req.anon_user_id || !req.anon_user_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  if (!req.loop_id || !req.loop_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 loop_id');
  }
  const attr = getAttributionByLoopForUser(req.loop_id, req.anon_user_id);
  if (!attr) {
    throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '归因记录不存在或无权限');
  }

  let cause_id = attr.cause_id;
  if (req.cause_id !== undefined) {
    if (req.cause_id !== null && !(req.cause_id in CAUSE_TAXONOMY)) {
      throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '未知错因类型');
    }
    cause_id = req.cause_id;
  }

  let kp_id = attr.knowledge_point_id;
  if (req.knowledge_point_id !== undefined) kp_id = req.knowledge_point_id;
  let kp_text = attr.knowledge_point;
  if (req.knowledge_point !== undefined) kp_text = req.knowledge_point;

  patchAttributionCause(req.loop_id, req.anon_user_id, cause_id, kp_id);

  // 知识点变更 → 重算新旧两处的掌握度（R09/R10/R14 聚合自然跟进）
  if (kp_id !== attr.knowledge_point_id) {
    try {
      if (attr.knowledge_point_id) {
        recomputeMastery(req.anon_user_id, attr.knowledge_point_id, attr.knowledge_point_id);
      }
      if (kp_id) {
        recomputeMastery(req.anon_user_id, kp_id, kp_id);
      }
    } catch {
      /* 重算为增强指标，异常不阻断主流程 */
    }
  }

  return {
    loop_id: req.loop_id,
    cause_id,
    knowledge_point: kp_text,
    knowledge_point_id: kp_id,
  };
}

// ----------------- R18 知识图谱 -----------------

/**
 * 以用户全部（kp, cause）对为数据源，构造知识点共现图：
 *  - 节点：去重知识点，error_count = 出现次数；
 *  - 边：两个知识点"共享同一错因"则相连，weight = 共享错因数（同错因=弱项聚类信号）。
 */
export function getKnowledgeGraph(anon_user_id: string): KnowledgeGraphResponse {
  if (!anon_user_id || !anon_user_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  const rows = getAttributionsKpCause(anon_user_id);

  const nodeMap = new Map<
    string,
    { kp_key: string; kp_text: string; error_count: number; causes: Set<string> }
  >();
  for (const row of rows) {
    const key = row.knowledge_point_id as string;
    if (!nodeMap.has(key)) {
      nodeMap.set(key, { kp_key: key, kp_text: key, error_count: 0, causes: new Set() });
    }
    const n = nodeMap.get(key)!;
    n.error_count += 1;
    if (row.cause_id) n.causes.add(row.cause_id);
  }

  const keys = [...nodeMap.keys()];
  const edges: KnowledgeGraphEdge[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = nodeMap.get(keys[i])!;
      const b = nodeMap.get(keys[j])!;
      const shared = [...a.causes].filter((c) => b.causes.has(c)).length;
      if (shared > 0) {
        edges.push({ source: keys[i], target: keys[j], weight: shared });
      }
    }
  }

  const nodes: KnowledgeGraphNode[] = [...nodeMap.values()].map((n) => ({
    kp_key: n.kp_key,
    kp_text: n.kp_text,
    error_count: n.error_count,
  }));

  return { anon_user_id, nodes, edges };
}
