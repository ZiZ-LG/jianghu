import type {
  CommandContext,
  PostMeetingFeishuProviderStatus,
  PostMeetingSourceOption,
} from '@jianghu/domain-contracts';

export interface PostMeetingSourceImportViewProps {
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  customerId: string;
  matterId: string;
  mode: 'upload' | 'feishu';
  feishuUrl: string;
  uploadFileName: string;
  appId: string;
  appSecret: string;
  providerStatus: PostMeetingFeishuProviderStatus | null;
  feishuConnected: boolean;
  selectedSource: PostMeetingSourceOption | null;
  busy: boolean;
  uploadProgress: number;
  error: string;
  notice: string;
  onModeChange: (mode: 'upload' | 'feishu') => void;
  onFeishuUrlChange: (value: string) => void;
  onFileChange: (file: File | null) => void;
  onAppIdChange: (value: string) => void;
  onAppSecretChange: (value: string) => void;
  onSaveProvider: () => void;
  onConnectFeishu: () => void;
  onRefreshCredentials: () => void;
  onImportAndRun: () => void;
  onRetryRun?: () => void;
  onDegrade: () => void;
  onDelete: () => void;
}

const ACCEPTED_FILES = '.txt,.md,.docx,.pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf';

export function PostMeetingSourceImportView(props: PostMeetingSourceImportViewProps) {
  if (props.readonly || props.actorRole === 'viewer') return null;
  const canConfigure = props.actorRole === 'owner' || props.actorRole === 'admin';
  const inputReady = props.mode === 'upload'
    ? Boolean(props.uploadFileName)
    : Boolean(props.feishuUrl.trim());
  const canImport = Boolean(props.customerId && props.matterId && inputReady) && !props.busy;
  const progress = Math.max(0, Math.min(100, Math.round(props.uploadProgress)));
  const providerReady = Boolean(props.providerStatus?.configured && props.providerStatus.enabled);

  return <div className="post-meeting-import" data-post-meeting-source-import="true">
    <div className="post-meeting-import-heading">
      <div>
        <strong>导入会议来源</strong>
        <p>仅导入当前客户与事项；生成的内容先进入候选批次。</p>
      </div>
      <small>客户 {props.customerId || '未选择'} · 事项 {props.matterId || '未选择'}</small>
    </div>

    <div className="post-meeting-import-modes" role="group" aria-label="来源方式">
      <label><input
        type="radio" name="post-meeting-import-mode" value="upload"
        checked={props.mode === 'upload'} disabled={props.busy}
        onChange={() => props.onModeChange('upload')}
      />上传文件</label>
      <label><input
        type="radio" name="post-meeting-import-mode" value="feishu"
        checked={props.mode === 'feishu'} disabled={props.busy}
        onChange={() => props.onModeChange('feishu')}
      />飞书妙记</label>
    </div>

    {props.mode === 'upload' ? <label className="post-meeting-import-field">会议文件
      <input
        type="file" accept={ACCEPTED_FILES} disabled={props.busy}
        onChange={(event) => props.onFileChange(event.target.files?.[0] ?? null)}
      />
      <small>{props.uploadFileName || '支持 TXT、Markdown、DOCX、文本型 PDF，单次一个文件。'}</small>
    </label> : <label className="post-meeting-import-field">飞书妙记链接或 token
      <input
        type="text" inputMode="url" value={props.feishuUrl} disabled={props.busy}
        placeholder="https://team.feishu.cn/minutes/..."
        onChange={(event) => props.onFeishuUrlChange(event.target.value)}
      />
    </label>}

    {props.mode === 'feishu' && <div className="post-meeting-feishu">
      {canConfigure && <div className="post-meeting-provider-config" data-feishu-provider-config="true">
        <label>飞书 App ID<input
          value={props.appId} disabled={props.busy}
          autoComplete="off"
          onChange={(event) => props.onAppIdChange(event.target.value)}
        /></label>
        <label>飞书 App Secret<input
          type="password" value={props.appSecret} disabled={props.busy}
          autoComplete="new-password" placeholder="留空即保留现有 Secret"
          onChange={(event) => props.onAppSecretChange(event.target.value)}
        /></label>
        <button className="btn ghost" disabled={props.busy || !props.appId.trim()} onClick={props.onSaveProvider}>保存飞书配置</button>
      </div>}
      <div className="post-meeting-oauth">
        <span>{props.feishuConnected ? '已连接' : providerReady ? '尚未连接' : '飞书提供方未就绪'}</span>
        <button className="btn ghost" disabled={props.busy || !providerReady} onClick={props.onConnectFeishu}>连接我的飞书账号</button>
        <button className="btn ghost" disabled={props.busy} onClick={props.onRefreshCredentials}>刷新授权状态</button>
      </div>
    </div>}

    {props.busy && <div className="post-meeting-import-progress">
      <progress max={100} value={progress} />
      <span>{progress > 0 ? `处理进度 ${progress}%` : '正在安全处理来源…'}</span>
    </div>}
    {props.error && <div className="post-meeting-message error" role="alert">{props.error}</div>}
    {props.notice && <div className="post-meeting-message success" role="status">{props.notice}</div>}

    <div className="post-meeting-import-actions">
      <button className="btn primary" disabled={!canImport} onClick={props.onImportAndRun}>导入并生成候选</button>
      {props.error && props.selectedSource && props.onRetryRun && <button
        className="btn ghost" disabled={props.busy}
        onClick={props.onRetryRun}
      >重试生成候选</button>}
    </div>

    {props.selectedSource && <div className="post-meeting-current-source">
      <div>
        <small>当前来源：</small>
        <strong>{props.selectedSource.title}</strong>
        <span>{props.selectedSource.kind} · {props.selectedSource.fingerprint.slice(0, 10)}…</span>
      </div>
      <div>
        {props.selectedSource.kind !== 'note' && <button className="btn ghost" disabled={props.busy} onClick={props.onDegrade}>降解正文</button>}
        <button className="btn danger" disabled={props.busy} onClick={props.onDelete}>删除来源</button>
      </div>
    </div>}
  </div>;
}
