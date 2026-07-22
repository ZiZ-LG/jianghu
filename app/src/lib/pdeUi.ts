// PDE 四动作 → 界面用语（DECISIONS 术语映射：内核英文键，展示层中文）。推演坞使用。
export const ACT_LABEL: Record<string, { icon: string; text: string; cls: string }> = {
  RAISE: { icon: '⬆', text: '强攻', cls: 'raise' },
  CALL: { icon: '▶', text: '跟进', cls: 'call' },
  CHECK: { icon: '🔍', text: '摸底', cls: 'check' },
  FOLD: { icon: '⛔', text: '止损', cls: 'fold' },
};
