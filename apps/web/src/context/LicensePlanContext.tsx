/**
 * 权益上下文：把「当前账号档位 / 权益集合」提供给侧边栏与页面，
 * 用于按档位显隐 / 锁定功能入口（与后端 requireEntitlement 闸门对称）。
 *
 * 关键约定：门禁关闭（gateEnabled=false，即开发态 / 默认分发前）时，has() 一律返回
 * true —— 全功能放行。这必须与后端 requireEntitlement 的行为完全一致：后端闸门关闭时
 * 不做任何 per-entitlement 拦截，因此前端也不应锁任何模块，否则开发态会被自己锁死。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Entitlement, LicensePlanResponse, LicenseTier } from '@aicorrection/shared';

interface LicensePlanContextValue {
  /** 当前档位（无数据时为 null）。 */
  tier: LicenseTier | null;
  /** 当前权益集合（无数据时为 []）。 */
  entitlements: Entitlement[];
  /** 门禁是否开启。 */
  gateEnabled: boolean;
  /** 是否仍在加载权益。 */
  loading: boolean;
  /** 是否拥有某权益（开发态恒 true）。 */
  has: (ent: Entitlement) => boolean;
  /** 主动刷新权益（续费 / 升级后调用）。 */
  refresh: () => Promise<void>;
}

const LicensePlanContext = createContext<LicensePlanContextValue | null>(null);

export function LicensePlanProvider({
  children,
  gateEnabled,
}: {
  children: ReactNode;
  gateEnabled: boolean;
}) {
  const [plan, setPlan] = useState<LicensePlanResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const p = await api.getLicensePlan();
      setPlan(p);
    } catch {
      // 权益查询失败（如过渡态 401）：保守视为「暂无数据」，由 has() 兜底。
      setPlan(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 仅在挂载时拉取一次；续费 / 升级后由 refresh() 主动刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const has = (ent: Entitlement): boolean => {
    if (!gateEnabled) return true; // 开发态：全功能放行（与后端一致）
    if (!plan) return false;
    return plan.entitlements.includes(ent);
  };

  const value: LicensePlanContextValue = {
    tier: plan?.tier ?? null,
    entitlements: plan?.entitlements ?? [],
    gateEnabled,
    loading,
    has,
    refresh: load,
  };

  return <LicensePlanContext.Provider value={value}>{children}</LicensePlanContext.Provider>;
}

export function useLicensePlan(): LicensePlanContextValue {
  const ctx = useContext(LicensePlanContext);
  if (!ctx) throw new Error('useLicensePlan 必须在 LicensePlanProvider 内使用');
  return ctx;
}
