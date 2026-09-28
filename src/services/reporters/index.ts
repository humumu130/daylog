// P8·上报平台注册表：UI 通过 getReporter(id) 拿适配器，不直接 import 具体实现。

export * from './types';
export { choerodonReporter } from './choerodon';
export * from './secrets';

import type { ReporterAdapter } from './types';
import { choerodonReporter } from './choerodon';

const REGISTRY: Record<string, ReporterAdapter> = {
  [choerodonReporter.id]: choerodonReporter,
};

/** 按平台 id 取适配器；未注册返回 null（调用方引导检查配置） */
export function getReporter(id: string): ReporterAdapter | null {
  return REGISTRY[id] ?? null;
}
