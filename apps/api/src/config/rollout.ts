/**
 * 灰度 / 金丝雀发布配置（K1.4）
 *
 * 设计红线：默认 ROLLOUT_STRATEGY='off' → 100% control，运行期现有行为零变化。
 * 仅当显式把策略切到 percentage / cohort，或打开某 treatment 功能开关时，才可能改变行为。
 *
 * 读取的环境变量（集中在 env.ts，保持与既有 Provider 配置一致的模式）：
 *   ROLLOUT_STRATEGY        'off' | 'percentage' | 'cohort'  （默认 'off'）
 *   ROLLOUT_PCT             0-100，仅 percentage 策略使用     （默认 0）
 *   ROLLOUT_COHORT_ALLOWLIST csv，显式白名单 anon_user_id      （默认 ''）
 *   ROLLOUT_KILL_SWITCH     '1' / 'true' → 强制 100% control  （默认 false）
 *   ROLLOUT_FEAT_NEW_EXPLAIN '1' / 'true' → 开启示例 treatment 功能（默认 false）
 *
 * 生效时机：除 ROLLOUT_KILL_SWITCH 外，以上变量由 env 模块在加载时一次性快照，
 * 改动需重启进程生效；kill-switch 是紧急熔断能力，由 getRolloutConfig() 动态
 * 读 process.env，运行时置 1 即时熔断、无需重启（见下方实现）。
 */
import { env } from './env';
import type { RolloutGroup } from '@aicorrection/shared';

export type RolloutStrategy = 'off' | 'percentage' | 'cohort';

export interface RolloutConfig {
  /** 实际生效策略（kill-switch 下回落 'off'） */
  strategy: RolloutStrategy;
  /** 百分比 0-100，仅 percentage 策略语义有效 */
  pct: number;
  /** 显式白名单（仅 cohort 策略使用） */
  cohortAllowlist: string[];
  /** kill-switch：true → 立即 100% 回退 control */
  killSwitch: boolean;
}

/**
 * 读取并规整运行期灰度配置。
 * kill-switch 优先级最高：一旦置位，无论策略如何都回落 'off'。
 *
 * kill-switch 由 getRolloutConfig() 动态读 process.env（不读 env 快照），保证
 * 进程启动后运行时置 '1' 也能立即熔断——紧急能力不能要求重启。
 * 其余 ROLLOUT_* 仍使用 env 模块加载时的一次性快照，改动需重启进程生效。
 */
export function getRolloutConfig(): RolloutConfig {
  // 与 env.ts 的 toBool 语义保持一致：'1' / 'true' 均视为置位。
  const killSwitchRaw = process.env.ROLLOUT_KILL_SWITCH;
  const killSwitch = killSwitchRaw === '1' || killSwitchRaw === 'true';
  const strategy: RolloutStrategy = killSwitch
    ? 'off'
    : (env.ROLLOUT_STRATEGY ?? 'off');
  const pct = Math.max(0, Math.min(100, Math.round(env.ROLLOUT_PCT)));
  const cohortAllowlist = env.ROLLOUT_COHORT_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { strategy, pct, cohortAllowlist, killSwitch };
}

// ===================== Feature Flag（treatment 功能门控） =====================

export interface RolloutFeatureFlag {
  /** 总开关：是否把该功能开放给 eligibleGroup */
  enabled: boolean;
  /** 仅对该组生效；treatment 功能默认只让 treatment 组看到 */
  eligibleGroup: RolloutGroup;
  description: string;
}

/**
 * Treatment 功能注册表（K1.4 示例 + 后续可扩展）。
 *
 * 示例功能 newExplanationStyle：新的"分步追问式讲解"风格。
 *   - 默认 enabled=false → 即使 treatment 组也看不到（默认关闭，符合安全红线）。
 *   - 显式打开后，仅 treatment 组命中（用于 A/B 对比认可率 / 延迟）。
 *   - control 组无论开关与否都拿不到，保证对照干净。
 */
export const ROLLOUT_FEATURE_FLAGS: Record<string, RolloutFeatureFlag> = {
  newExplanationStyle: {
    enabled: env.ROLLOUT_FEAT_NEW_EXPLAIN,
    eligibleGroup: 'treatment',
    description: '新的"分步追问式讲解"风格（treatment-only 实验）',
  },
};

/**
 * 某 cohort 是否应启用某 feature。
 * 尊重总开关 + 仅对 eligibleGroup 生效；未知 feature / 未开启 → false。
 */
export function isFeatureEnabled(
  featureId: string,
  cohort: { group: RolloutGroup }
): boolean {
  const flag = ROLLOUT_FEATURE_FLAGS[featureId];
  if (!flag || !flag.enabled) return false;
  return cohort.group === flag.eligibleGroup;
}
