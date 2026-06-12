// 策略引擎（PDE）公共出口。core = 可移植内核；adapter = 江湖映射 + G64111 文案；playbook = 方案包推演。
export * from './core';
export { analyzeDeal, buildPdeInput, DEFAULT_PDE_PARAMS, STANCE_LABEL, type JianghuPdeResult, type StanceShift } from './adapter';
export { buildPlaybooks, type Playbook, type PlaybookCard, type PlaybookAction } from './playbook';
export { SIGNAL_CATALOG, SIGNAL_BY_KEY, evidenceAlpha, type SignalDef, type SignalTier } from './signals';
