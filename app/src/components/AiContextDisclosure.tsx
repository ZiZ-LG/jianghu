import type { AiContextOptions, ContextManifest } from '../aiContext';

const CATEGORY_LABEL: Record<string, string> = {
  'account-summary': '客户摘要',
  'opportunity-summary': '商机摘要',
  'g64111-score': 'G64111 得分',
  'roles-and-sentiment': '角色与支持度',
  'relationship-metadata': '关系元数据',
  'business-issues-and-value': 'BI 与 UCV',
  form: 'FORM',
  'raw-logs': '原始日志',
  'private-bi': '私密 BI',
  'self-logs': 'self 日志',
  'outside-opportunity': '非当前商机数据',
};

export function AiContextDisclosure({
  manifest,
  options,
  onChange,
  loading,
  error,
}: {
  manifest: ContextManifest | null;
  options: AiContextOptions;
  onChange: (options: AiContextOptions) => void;
  loading: boolean;
  error?: string;
}) {
  return (
    <div className="ai-context-disclosure" aria-live="polite">
      <div className="ai-context-title">🔐 发送前数据范围</div>
      {manifest ? (
        <div className="ai-context-summary">
          1 个客户 · 1 个商机 · {manifest.entities.people} 人 · {manifest.entities.relationships} 条关系 · {manifest.entities.burningIssues} 条 BI · {manifest.entities.ucvs} 条 UCV · {manifest.entities.interactionLogs} 条日志
          <br />字段：{manifest.fieldCategories.map((key) => CATEGORY_LABEL[key] ?? key).join('、')}
        </div>
      ) : <div className="ai-context-summary">{loading ? '正在核对服务端可见范围…' : (error || '暂时无法确认数据范围')}</div>}
      <div className="ai-context-options">
        <label><input type="checkbox" checked={options.includeRawLogs} onChange={(event) => onChange({ ...options, includeRawLogs: event.target.checked })} /> 包含原始交往日志</label>
        <label><input type="checkbox" checked={options.includeForm} onChange={(event) => onChange({ ...options, includeForm: event.target.checked })} /> 包含 FORM 背景</label>
      </div>
      {manifest && (
        <div className="ai-context-excluded">
          已排除：{manifest.excludedSensitiveCategories.map((key) => CATEGORY_LABEL[key] ?? key).join('、')}
        </div>
      )}
    </div>
  );
}
