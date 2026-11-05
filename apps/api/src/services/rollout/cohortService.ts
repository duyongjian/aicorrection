/**
 * Cohort 分配服务（K1.4）
 *
 * 确定性、稳定：同一 anon_user_id 永远落到同一组（hash 稳定、无随机、无时钟依赖）。
 * 纯函数、无 DB / 无 IO，可直接单测（cohortService.test.ts）。
 *
 * 分配优先级（与 config/rollout.ts 的 getRolloutConfig 配合）：
 *   kill-switch → off(100% control) → cohort 白名单 → percentage(bucket<pct) → 默认 control
 */
import { getRolloutConfig, type RolloutStrategy } from '../../config/rollout';
import type { RolloutGroup } from '@aicorrection/shared';

export interface CohortAssignment {
  /** 分配到的组 */
  group: RolloutGroup;
  /** 当前生效百分比（off → 0；cohort → 0 或 100；percentage → 实际 pct） */
  pct: number;
  /** 实际生效策略（kill-switch 下回落 'off'，便于审计） */
  strategy: RolloutStrategy;
  /** 分配原因（便于调试 / 审计日志） */
  reason: string;
}

/** FNV-1a 32-bit 哈希，返回无符号整数。确定性、无外部依赖。 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime 16777619；用 Math.imul 保持在 32 位内乘法
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 将 anon_user_id 稳定映射到 [0, 100) 的 bucket。空 id 视为 bucket 0。 */
export function bucketOf(anonUserId: string): number {
  if (!anonUserId) return 0;
  return fnv1a32(anonUserId) % 100;
}

export interface AssignOptions {
  /** 覆盖运行期配置（测试 / 显式传入）；不传则使用 getRolloutConfig()。 */
  config?: {
    strategy: RolloutStrategy;
    pct: number;
    cohortAllowlist: string[];
    killSwitch: boolean;
  };
}

/**
 * 分配用户到 control / treatment。
 * 纯函数：相同输入永远得到相同输出；不触碰 DB / 网络 / 时钟。
 */
export function assignCohort(
  anonUserId: string,
  opts?: AssignOptions
): CohortAssignment {
  const cfg = opts?.config ?? getRolloutConfig();

  // 1) kill-switch：一旦置位，立即 100% 回退 control（最高优先级）。
  if (cfg.killSwitch) {
    return { group: 'control', pct: 0, strategy: 'off', reason: 'kill_switch' };
  }

  // 2) off：100% control（默认 & 安全红线）。
  if (cfg.strategy === 'off') {
    return { group: 'control', pct: 0, strategy: 'off', reason: 'strategy_off' };
  }

  // 3) cohort：白名单内强制 treatment；名单外 control。
  if (cfg.strategy === 'cohort') {
    if (anonUserId && cfg.cohortAllowlist.includes(anonUserId)) {
      return {
        group: 'treatment',
        pct: 100,
        strategy: 'cohort',
        reason: 'allowlist',
      };
    }
    return {
      group: 'control',
      pct: 0,
      strategy: 'cohort',
      reason: 'allowlist_miss',
    };
  }

  // 4) percentage：bucket = hash mod 100；bucket < pct → treatment，否则 control。
  if (cfg.strategy === 'percentage') {
    const pct = Math.max(0, Math.min(100, Math.round(cfg.pct)));
    if (pct <= 0) {
      return { group: 'control', pct: 0, strategy: 'percentage', reason: 'pct_zero' };
    }
    if (pct >= 100) {
      return { group: 'treatment', pct: 100, strategy: 'percentage', reason: 'pct_full' };
    }
    const bucket = bucketOf(anonUserId);
    const inTreatment = bucket < pct;
    return {
      group: inTreatment ? 'treatment' : 'control',
      pct,
      strategy: 'percentage',
      reason: inTreatment
        ? `bucket_${bucket}_<_${pct}`
        : `bucket_${bucket}_>=_${pct}`,
    };
  }

  // 兜底（理论不可达）：control。
  return { group: 'control', pct: 0, strategy: 'off', reason: 'fallback' };
}
