/**
 * 归因编排层：按 ATTRIBUTION_STRATEGY 顶层分流，避免循环依赖。
 *  - single（默认）：单模型归因（ANALYSIS_* 指向的本地强模型）。
 *  - ensemble      ：方案2·本地多模型编排（免费）。
 *  - cloud         ：方案1·大模型 API（CLOUD_* 配置，省事）。
 * 集成路径内部通过 providerOverride / precomputedText 回调 generateAttributionImpl，
 * 故本层只做一次性分流；generionAttribution 的具体实现见 attributionService。
 */
import { env } from '../../config/env';
import { generateAttribution as generateAttributionImpl, type AttrInput } from './attributionService';
import { generateEnsembleAttribution } from './ensemble';
import * as rt from '../admin/runtimeSettings';

export function generateAttribution(input: AttrInput) {
  // ATTRIBUTION_STRATEGY 可被管理后台运行时覆盖（runtimeSettings），未覆盖时回落 env。
  const strategy = rt.getStr('ATTRIBUTION_STRATEGY', env.ATTRIBUTION_STRATEGY);
  if (
    strategy === 'ensemble' &&
    !input.providerOverride &&
    input.precomputedText == null
  ) {
    return generateEnsembleAttribution(input);
  }
  return generateAttributionImpl(input);
}
