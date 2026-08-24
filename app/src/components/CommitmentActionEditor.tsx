import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { InterventionItem } from '@jianghu/domain-contracts';
import {
  resolveBrowserTimeZone,
} from '../lib/quickCapture';
import type {
  BuildTodayCommitmentActionInput,
  TodayCommitmentAction,
  TodayCommitmentScheduleInput,
} from '../lib/commitmentActions';

interface CommitmentActionEditorProps {
  item: InterventionItem;
  action: TodayCommitmentAction;
  actorUserId: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onInputChanged: () => void;
  onSubmit: (input: BuildTodayCommitmentActionInput) => void;
}

function initialTimeZone(item: InterventionItem): string {
  return 'timeZone' in item.time ? item.time.timeZone : resolveBrowserTimeZone();
}

function actionExplanation(action: TodayCommitmentAction): string {
  if (action.kind === 'confirm') return '确认后会记录当前确认人和确认时间。';
  if (action.kind === 'decline') return '拒绝只改变当前日程修订的确认状态，不会自动改期。';
  if (action.kind === 'complete') return '完成后可以继续补充一个与当前客户、事项关联的新下一步。';
  if (action.kind === 'cancel') return '取消会结束这条正式下一步；如需继续推进，可之后新建下一步。';
  if (action.kind === 'mark_missed') return '这会把正式状态标记为“已错过”，系统不会自动执行这项操作。';
  if (action.kind === 'create_next') return '新记录只继承当前客户与事项，标题和时间必须由你明确填写。';
  return '调整时间会保留同一条记录、递增 scheduleVersion，并使旧确认失效。';
}

export function CommitmentActionEditor({
  item,
  action,
  actorUserId,
  saving,
  error,
  onCancel,
  onInputChanged,
  onSubmit,
}: CommitmentActionEditorProps) {
  const headingId = useId();
  const editorRef = useRef<HTMLElement>(null);
  const [isAllDay, setIsAllDay] = useState(false);
  const [localDateTime, setLocalDateTime] = useState('');
  const [localDate, setLocalDate] = useState('');
  const [timeZone, setTimeZone] = useState(() => initialTimeZone(item));
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);
  const [confirmationDueLocalDateTime, setConfirmationDueLocalDateTime] = useState('');
  const [reason, setReason] = useState('');
  const [nextTitle, setNextTitle] = useState('');

  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  const schedule = (): TodayCommitmentScheduleInput => ({
    isAllDay,
    localDateTime,
    localDate,
    timeZone,
    requiresConfirmation,
    confirmationDueLocalDateTime,
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const base: BuildTodayCommitmentActionInput = {
      item,
      kind: action.kind,
      actorUserId,
    };
    if (action.kind === 'reschedule') base.schedule = schedule();
    if (action.kind === 'cancel') base.reason = reason;
    if (action.kind === 'create_next') {
      base.next = { title: nextTitle, schedule: schedule() };
    }
    onSubmit(base);
  };

  const changed = <T,>(setter: (value: T) => void, value: T) => {
    onInputChanged();
    setter(value);
  };

  const needsSchedule = action.kind === 'reschedule' || action.kind === 'create_next';

  return (
    <div
      className="today-action-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <section
        ref={editorRef}
        className="today-action-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
          )];
          if (focusable.length === 0) {
            event.preventDefault();
            event.currentTarget.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
      <header>
        <div>
          <span className="today-action-kicker">正式写入前确认</span>
          <h3 id={headingId}>{action.confirmLabel}</h3>
        </div>
        <button type="button" className="btn ghost sm" disabled={saving} onClick={onCancel} aria-label="关闭操作确认">
          关闭
        </button>
      </header>
      <p className="today-action-target">
        <strong>{item.context.customerName}</strong>
        {item.context.matterName ? <span> · {item.context.matterName}</span> : null}
        <span> · {item.title}</span>
      </p>
      <p>{actionExplanation(action)}</p>
      <p className="today-action-revision">
        提交时核对 v{item.target.version} / schedule {item.target.scheduleVersion}；记录变化后不会覆盖。
      </p>

      <form onSubmit={submit}>
        <fieldset disabled={saving}>
          <legend>操作内容</legend>
          {action.kind === 'create_next' ? (
            <label>
              <span>新的下一步</span>
              <input
                name="nextTitle"
                value={nextTitle}
                maxLength={200}
                autoComplete="off"
                required
                onChange={(event) => changed(setNextTitle, event.currentTarget.value)}
              />
            </label>
          ) : null}

          {needsSchedule ? (
            <div className="today-action-schedule">
              <label className="today-action-check">
                <input
                  type="checkbox"
                  checked={isAllDay}
                  onChange={(event) => changed(setIsAllDay, event.currentTarget.checked)}
                />
                <span>全天事项</span>
              </label>
              {isAllDay ? (
                <label>
                  <span>业务日期</span>
                  <input
                    type="date"
                    value={localDate}
                    required
                    onChange={(event) => changed(setLocalDate, event.currentTarget.value)}
                  />
                </label>
              ) : (
                <label>
                  <span>日期和时间</span>
                  <input
                    type="datetime-local"
                    value={localDateTime}
                    required
                    onChange={(event) => changed(setLocalDateTime, event.currentTarget.value)}
                  />
                </label>
              )}
              <label>
                <span>时区</span>
                <input
                  value={timeZone}
                  spellCheck={false}
                  required
                  aria-describedby={`${headingId}-timezone-hint`}
                  onChange={(event) => changed(setTimeZone, event.currentTarget.value)}
                />
                <small id={`${headingId}-timezone-hint`}>使用 IANA 时区，例如 Asia/Shanghai。</small>
              </label>
              <label className="today-action-check">
                <input
                  type="checkbox"
                  checked={requiresConfirmation}
                  onChange={(event) => {
                    changed(setRequiresConfirmation, event.currentTarget.checked);
                    if (!event.currentTarget.checked) setConfirmationDueLocalDateTime('');
                  }}
                />
                <span>需要对方确认</span>
              </label>
              {requiresConfirmation ? (
                <label>
                  <span>确认截止时间</span>
                  <input
                    type="datetime-local"
                    value={confirmationDueLocalDateTime}
                    required
                    onChange={(event) => changed(setConfirmationDueLocalDateTime, event.currentTarget.value)}
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {action.kind === 'cancel' ? (
            <label>
              <span>取消原因（可选）</span>
              <textarea
                value={reason}
                maxLength={500}
                rows={3}
                onChange={(event) => changed(setReason, event.currentTarget.value)}
              />
            </label>
          ) : null}
        </fieldset>

        {error ? <p className="today-action-error" role="alert">{error}</p> : null}
        <div className="today-action-buttons">
          <button
            className={`btn ${action.danger ? 'danger' : 'primary'}`}
            type="submit"
            disabled={saving}
          >
            {saving ? '提交中…' : action.confirmLabel}
          </button>
          <button className="btn ghost" type="button" disabled={saving} onClick={onCancel}>返回</button>
        </div>
      </form>
      </section>
    </div>
  );
}
