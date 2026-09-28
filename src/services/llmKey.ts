// P8·LLM API Key 存取：明文只进 OS keychain（Rust secret_put/get/delete，
// service='daylog' account='llm-api-key'），settings.llm.apiKey 不再落明文。
// 独立于 reporters/secrets.ts（后者 import useSettingsStore；本模块被 llm.ts
// 引用，保持零 store 依赖防环）。非 Tauri 环境（测试/node）一律返回 null。

import { invoke } from '@tauri-apps/api/core';

export const LLM_KEYCHAIN_SERVICE = 'daylog';
export const LLM_KEY_ACCOUNT = 'llm-api-key';

/** 读取 LLM API Key；null=未配置（空串/非 tauri 环境同视为未配置，不抛错） */
export async function loadLlmKey(): Promise<string | null> {
  try {
    const v = await invoke<string | null>('secret_get', {
      service: LLM_KEYCHAIN_SERVICE,
      account: LLM_KEY_ACCOUNT,
    });
    return v && v !== '' ? v : null;
  } catch {
    return null; // 非 tauri 环境 / keychain 异常：不阻塞调用方（会以无 key 报错）
  }
}

export async function saveLlmKey(key: string): Promise<void> {
  await invoke<void>('secret_put', { service: LLM_KEYCHAIN_SERVICE, account: LLM_KEY_ACCOUNT, value: key });
}

export async function clearLlmKey(): Promise<void> {
  await invoke<void>('secret_delete', { service: LLM_KEYCHAIN_SERVICE, account: LLM_KEY_ACCOUNT });
}

/** 出网用 key 解析：settings 内联值（迁移过渡期）优先，空则回落 keychain */
export async function resolveLlmKey(inline: string | undefined | null): Promise<string> {
  const k = (inline ?? '').trim();
  if (k) return k;
  return (await loadLlmKey()) ?? '';
}

/** LLM 是否配有可用 key（内联或 keychain）：llmReady/降级判定等统一走这里 */
export async function hasLlmApiKey(llm: { apiKey?: string | null }): Promise<boolean> {
  if ((llm.apiKey ?? '').trim() !== '') return true;
  return (await loadLlmKey()) !== null;
}
