import { defineConfig } from 'vitest/config';

// 单测只覆盖纯逻辑层（采集引擎机制/噪音通道回归等）；UI 与 Tauri 桥接走装机验收。
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
