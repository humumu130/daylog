// 采集引擎公共出口（P5）。UI 层（P6 采集中心/今日页日菜单）只从这里 import。

export type { AiEvent, AiEventKind, AiParseResult, AiSessionInfo, AiTodoInfo, CollectorCtx, CwdSummary, DiscoveredRepo, EngineInput, NoiseReview, NoiseStatus, RunSummary } from './types';
export { scanSessions, toEngineInputs, makeResolver, eventFingerprint, commitFingerprint, sha256Hex, defaultScanRoots, type ProjectResolver, type ScanOutcome } from './scan';
export { runConsolidate, rebuildDay, undoDay, previewConsolidate, type ConsolidateOptions } from './engine';
export { ingestTodos, type TodoIngestResult } from './todoIngest';
export { startCollector, stopCollector, collectOnce, manualScanNow, type CollectPassResult } from './schedule';
export { scrubText, scrubPayload, scrubTotals } from './scrub';
export { buildIntervals, boundsFor, overtimeMinutes, totalOvertimeMinutes, activeTotalMinutes, type OvertimeBounds } from './intervals';
export * as collectorState from './state';
