import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PostMeetingSourceImportView } from './PostMeetingSourceImport';

const source = {
  id: 'source-1', customerId: 'customer-1', matterId: 'matter-1', title: '客户会谈.md',
  kind: 'uploaded_file' as const, fingerprint: 'b'.repeat(64), aclVersion: 4, version: 4,
  occurredAt: '2026-08-25T18:00:00.000Z',
};

const baseProps = {
  actorRole: 'owner' as const,
  readonly: false,
  customerId: 'customer-1',
  matterId: 'matter-1',
  mode: 'upload' as const,
  feishuUrl: '',
  uploadFileName: '客户会谈.md',
  appId: 'cli_safe_app_id',
  appSecret: '',
  providerStatus: {
    configured: true, appId: 'cli_safe_app_id', hasSecret: true, enabled: true,
    redirectUri: 'https://crm.lake2ocean.top/api/recording/oauth/feishu/callback',
  },
  feishuConnected: true,
  selectedSource: source,
  busy: false,
  uploadProgress: 0,
  error: '',
  notice: '',
  onModeChange: () => undefined,
  onFeishuUrlChange: () => undefined,
  onFileChange: () => undefined,
  onAppIdChange: () => undefined,
  onAppSecretChange: () => undefined,
  onSaveProvider: () => undefined,
  onConnectFeishu: () => undefined,
  onRefreshCredentials: () => undefined,
  onImportAndRun: () => undefined,
  onRetryRun: () => undefined,
  onDegrade: () => undefined,
  onDelete: () => undefined,
};

describe('PostMeetingSourceImportView', () => {
  it('renders exactly one accepted file or one Feishu link on the selected Customer/Matter', () => {
    const html = renderToStaticMarkup(createElement(PostMeetingSourceImportView, baseProps));
    expect(html).toContain('data-post-meeting-source-import="true"');
    expect(html).toContain('value="upload"');
    expect(html).toContain('value="feishu"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".txt,.md,.docx,.pdf');
    expect(html).not.toContain('multiple=""');
    expect(html).toContain('客户 customer-1 · 事项 matter-1');
    expect(html).toContain('导入并生成候选');
    expect(html).toContain('当前来源：');
    expect(html).toContain('降解正文');
    expect(html).toContain('删除来源');
  });

  it('lets owner/admin configure the provider but keeps App Secret write-only', () => {
    const html = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps, mode: 'feishu' as const,
    }));
    expect(html).toContain('data-feishu-provider-config="true"');
    expect(html).toContain('飞书 App ID');
    expect(html).toContain('type="password"');
    expect(html).toContain('留空即保留现有 Secret');
    expect(html).toContain('已连接');
    expect(html).not.toContain('token-value');
    expect(html).not.toContain('ciphertext');
    expect(html).not.toContain('source body');
  });

  it('lets a member authorize only their own account and hides tenant configuration', () => {
    const html = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps,
      actorRole: 'member' as const,
      mode: 'feishu' as const,
    }));
    expect(html).not.toContain('data-feishu-provider-config="true"');
    expect(html).toContain('连接我的飞书账号');
    expect(html).toContain('刷新授权状态');
    expect(html).toContain('导入并生成候选');
  });

  it('suppresses every write control for viewer or readonly surfaces', () => {
    expect(renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps, actorRole: 'viewer' as const,
    }))).toBe('');
    expect(renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps, readonly: true,
    }))).toBe('');
  });

  it('shows bounded progress and safe errors without clearing the imported source', () => {
    const html = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps,
      busy: true,
      uploadProgress: 55,
      error: '来源已导入；候选任务失败，可重试。',
    }));
    expect(html).toContain('value="55"');
    expect(html).toContain('来源已导入；候选任务失败，可重试。');
    expect(html).toContain('客户会谈.md');
    expect(html).toContain('重试生成候选');
  });

  it('disables import when the selected anchor or selected input is incomplete', () => {
    const missingAnchor = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps, matterId: '',
    }));
    const missingFile = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps, uploadFileName: '',
    }));
    const missingLink = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps, mode: 'feishu' as const, feishuUrl: '',
    }));
    expect(missingAnchor).toMatch(/<button[^>]*disabled=""[^>]*>导入并生成候选<\/button>/);
    expect(missingFile).toMatch(/<button[^>]*disabled=""[^>]*>导入并生成候选<\/button>/);
    expect(missingLink).toMatch(/<button[^>]*disabled=""[^>]*>导入并生成候选<\/button>/);
  });

  it('does not offer a Job retry for an import-validation error', () => {
    const html = renderToStaticMarkup(createElement(PostMeetingSourceImportView, {
      ...baseProps,
      error: '请选择一个支持的会议文件。',
      onRetryRun: undefined,
    }));
    expect(html).not.toContain('重试生成候选');
  });
});
