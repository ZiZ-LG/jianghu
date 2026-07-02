// pde-kernel 公共出口：纯函数内核 + 参数 + 类型（SPEC §1）。
export * from './types.js';
export * from './params.js';
export { decay, blend, entropy3, evaluate, weightedScore, applyEffect, actionDeltaEV, voiStance, voiCComp, recommend } from './kernel.js';
