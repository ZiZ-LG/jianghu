import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TodayReadModelSchema,
  type TodayReadModel,
} from '@jianghu/domain-contracts';
import * as TodayComponents from './TodayPanel';

type TodayViewComponent = (props: {
  model: TodayReadModel;
  onOpenSource: (source: TodayReadModel['sections'][number]['items'][number]['sourceRefs'][number]) => void;
  readonly?: boolean;
  onAction?: (...args: never[]) => void;
}) => ReturnType<typeof createElement>;

type TodayPanelStateViewComponent = (props: {
  state: { status: 'error'; message: string };
  onRetry: () => void;
  onOpenSource: (source: TodayReadModel['sections'][number]['items'][number]['sourceRefs'][number]) => void;
}) => ReturnType<typeof createElement>;

const source = (entityKind: 'commitment' | 'matter', entityId: string, version: number, scheduleVersion: number | null) => ({
  entityKind, entityId, version, scheduleVersion,
});

describe('SAAS-103 Today surface', () => {
  it('renders a recoverable read failure without showing stale local aggregation', () => {
    const TodayPanelStateView = Reflect.get(TodayComponents, 'TodayPanelStateView') as TodayPanelStateViewComponent | undefined;
    expect(TodayPanelStateView, 'TodayPanelStateView must be exported').toBeDefined();

    const html = renderToStaticMarkup(createElement(TodayPanelStateView!, {
      state: { status: 'error', message: '今日数据暂时不可用' },
      onRetry: () => undefined,
      onOpenSource: () => undefined,
    }));
    expect(html).toContain('data-today-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('今日数据暂时不可用');
    expect(html).toContain('重新加载');
    expect(html).not.toContain('当前关注');
  });

  it('renders three fixed sections, exact-revision actions, and readonly suppression', () => {
    const TodayView = Reflect.get(TodayComponents, 'TodayView') as TodayViewComponent | undefined;
    expect(TodayView, 'TodayView must be exported').toBeDefined();

    const model = TodayReadModelSchema.parse({
      generatedAtUtc: '2026-08-23T19:00:00.000Z',
      sections: [
        {
          key: 'pending_confirmation', label: '待确认', items: [{
            id: 'today:confirmation_due:commitment-1:v2:s3',
            section: 'pending_confirmation', providerKey: 'core.today', title: '确认周一会议',
            context: { customerName: '远山制造', matterName: '方案交流' },
            reasonCode: 'confirmation_due', explanation: '确认截止时间已经到达。',
            sourceRefs: [source('commitment', 'commitment-1', 2, 3)],
            observedAtUtc: '2026-08-23T19:00:00.000Z', ruleVersion: 'core.today.v1',
            time: {
              kind: 'instant', atUtc: '2026-08-23T18:00:00.000Z', timeZone: 'America/Los_Angeles',
              relation: 'overdue', label: '确认已逾期',
            },
            suggestedAction: { kind: 'confirm_commitment', label: '确认或调整时间', commandType: 'CONFIRM_COMMITMENT' },
            target: {
              entityKind: 'commitment', entityId: 'commitment-1', customerId: 'customer-1',
              matterId: 'matter-1', commitmentId: 'commitment-1', version: 2, scheduleVersion: 3,
            },
          }],
        },
        {
          key: 'follow_up', label: '待跟进', items: [
            {
              id: 'today:matter_without_next_commitment:matter-2:v4',
              section: 'follow_up', providerKey: 'core.today', title: '续费准备',
              context: { customerName: '远山制造', matterName: '续费准备' },
              reasonCode: 'matter_without_next_commitment', explanation: '该事项仍在进行，但当前没有计划中的下一步。',
              sourceRefs: [source('matter', 'matter-2', 4, null)],
              observedAtUtc: '2026-08-23T19:00:00.000Z', ruleVersion: 'core.today.v1',
              time: {
                kind: 'observed', atUtc: '2026-08-23T19:00:00.000Z', relation: 'missing', label: '当前未记录下一步',
              },
              suggestedAction: { kind: 'create_commitment', label: '补一个下一步', commandType: 'CREATE_COMMITMENT' },
              target: {
                entityKind: 'matter', entityId: 'matter-2', customerId: 'customer-1',
                matterId: 'matter-2', commitmentId: null, version: 4, scheduleVersion: null,
              },
            },
            {
              id: 'today:commitment_due:commitment-2:v0:s0',
              section: 'follow_up', providerKey: 'core.today', title: '明天复核方案',
              context: { customerName: '远山制造', matterName: '方案交流' },
              reasonCode: 'commitment_due', explanation: '这条下一步将在明天进入跟进窗口。',
              sourceRefs: [source('commitment', 'commitment-2', 0, 0)],
              observedAtUtc: '2026-08-23T19:00:00.000Z', ruleVersion: 'core.today.v1',
              time: {
                kind: 'instant', atUtc: '2026-08-24T18:00:00.000Z', timeZone: 'America/Los_Angeles',
                relation: 'upcoming', label: '明天 11:00',
              },
              suggestedAction: { kind: 'complete_commitment', label: '完成后记录结果', commandType: 'COMPLETE_COMMITMENT' },
              target: {
                entityKind: 'commitment', entityId: 'commitment-2', customerId: 'customer-1',
                matterId: 'matter-1', commitmentId: 'commitment-2', version: 0, scheduleVersion: 0,
              },
            },
          ],
        },
        { key: 'completed', label: '已完成', items: [] },
      ],
    });
    const html = renderToStaticMarkup(createElement(TodayView!, {
      model,
      onOpenSource: () => undefined,
      readonly: false,
      onAction: () => undefined,
    }));

    expect([...html.matchAll(/data-today-section="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'pending_confirmation', 'follow_up', 'completed',
    ]);
    expect(html.indexOf('待确认')).toBeLessThan(html.indexOf('待跟进'));
    expect(html.indexOf('待跟进')).toBeLessThan(html.indexOf('已完成'));
    expect(html).toContain('为什么现在');
    expect(html).toContain('确认截止时间已经到达。');
    expect(html).toContain('core.today.v1');
    expect(html).toContain('commitment-1 · v2 · schedule 3');
    expect(html).not.toContain('data-today-command="CREATE_COMMITMENT"');
    expect(html).toContain('data-today-action="confirm"');
    expect(html).toContain('data-today-command="CONFIRM_COMMITMENT"');
    expect(html).toContain('data-today-action="reschedule"');
    expect(html).toContain('data-today-action="complete"');
    expect(html).not.toContain('data-today-action="mark_missed"');
    expect(html).toContain('data-today-source="commitment"');
    expect(html).toContain('data-source-version="2"');
    expect(html).toContain('<h3');
    expect(html).toContain('aria-labelledby="');
    expect(html).toContain('本段暂时没有项目');
    expect(html).toContain('明日跟进');

    expect(html).toContain('建议：补一个下一步');
    expect(Reflect.get(TodayComponents, 'TODAY_REFRESH_INTERVAL_MS')).toBeLessThanOrEqual(60_000);

    const readonlyHtml = renderToStaticMarkup(createElement(TodayView!, {
      model,
      onOpenSource: () => undefined,
      readonly: true,
      onAction: () => undefined,
    }));
    expect(readonlyHtml).not.toContain('data-today-action=');
  });
});
