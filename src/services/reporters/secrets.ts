// P8·PAT 密钥存取：明文只进 OS keychain（Rust secret_put/get/delete，service='daylog'），
// settings 里只留尾 4 位（patTail）供显示。Rust 命令签名（并行已就位）：
//   secret_put(service, account, value) / secret_get(service, account) -> Option<String>
//   / secret_delete(service, account)

import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { ReporterCtx } from './types';

export const KEYCHAIN_SERVICE = 'daylog';
export const PAT_ACCOUNT = 'choerodon-pat';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 保存 PAT 到 OS keychain（同时是「配置 PAT」这个动作的落库点） */
export async function savePat(pat: string): Promise<void> {
  try {
    await invoke<void>('secret_put', { service: KEYCHAIN_SERVICE, account: PAT_ACCOUNT, value: pat });
  } catch (e) {
    throw new Error(`保存 PAT 失败（keychain service=${KEYCHAIN_SERVICE} account=${PAT_ACCOUNT}）：${errMsg(e)}`);
  }
}

/** 读取 PAT；null=未配置（空串同样视为未配置） */
export async function loadPat(): Promise<string | null> {
  try {
    const v = await invoke<string | null>('secret_get', { service: KEYCHAIN_SERVICE, account: PAT_ACCOUNT });
    return v && v !== '' ? v : null;
  } catch (e) {
    throw new Error(`读取 PAT 失败（keychain service=${KEYCHAIN_SERVICE} account=${PAT_ACCOUNT}）：${errMsg(e)}`);
  }
}

/** 清除 PAT（断开对接 / 换号） */
export async function clearPat(): Promise<void> {
  try {
    await invoke<void>('secret_delete', { service: KEYCHAIN_SERVICE, account: PAT_ACCOUNT });
  } catch (e) {
    throw new Error(`清除 PAT 失败（keychain service=${KEYCHAIN_SERVICE} account=${PAT_ACCOUNT}）：${errMsg(e)}`);
  }
}

/**
 * 组装适配器调用上下文：settings.choerodon 的 baseUrl/orgId + keychain 里的 PAT。
 * 返回 null=未就绪（choerodon 未配置 / baseUrl 空 / PAT 未存），调用方引导用户去设置页。
 *
 * 循环依赖说明：useSettingsStore 仅依赖 services/store 与 services/events，
 * 均不依赖本目录，无环——故选择直接 import store（备选的「参数传入」方案未采用）。
 */
export async function getReporterCtx(): Promise<ReporterCtx | null> {
  const { settings } = useSettingsStore.getState();
  const ch = settings.choerodon;
  if (!ch || !ch.baseUrl) return null;
  const pat = await loadPat();
  if (!pat) return null;
  return {
    baseUrl: ch.baseUrl,
    pat,
    orgId: ch.orgId || undefined,
  };
}
