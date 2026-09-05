import { CUSTOMER_NAME_MAX_LENGTH, QUICK_CAPTURE_TITLE_MAX_LENGTH } from '@jianghu/domain-contracts';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { QuickCaptureAccountOption } from '../lib/crmContext';
import {
  buildQuickCaptureDraft,
  parseNaturalQuickCapture,
  QUICK_CAPTURE_NATURAL_TEXT_MAX_LENGTH,
  resolveBrowserTimeZone,
  saveAndRefreshQuickCaptureDraft,
  type QuickCaptureDraft,
  type QuickCaptureInput,
} from '../lib/quickCapture';

const NEW_CUSTOMER = '__new__';

export function QuickCapture({
  accounts,
  actorUserId,
  readonly,
  onSaved,
  initialCustomerId,
  initialMatterId,
}: {
  accounts: QuickCaptureAccountOption[];
  actorUserId: string;
  readonly: boolean;
  onSaved: () => Promise<unknown>;
  initialCustomerId?: string;
  initialMatterId?: string;
}) {
  const [customerSelection, setCustomerSelection] = useState(initialCustomerId ?? (accounts.length === 0 ? NEW_CUSTOMER : ''));
  const [newCustomerName, setNewCustomerName] = useState('');
  const [title, setTitle] = useState('');
  const [localDateTime, setLocalDateTime] = useState('');
  const [matterId, setMatterId] = useState(initialMatterId ?? '');
  const [personId, setPersonId] = useState('');
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);
  const [confirmationDueLocalDateTime, setConfirmationDueLocalDateTime] = useState('');
  const [naturalText, setNaturalText] = useState('');
  const [draft, setDraft] = useState<QuickCaptureDraft | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState('');
  const [timeZone] = useState(resolveBrowserTimeZone);
  const customerRef = useRef<HTMLSelectElement>(null);
  const draftRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  const contextRevision = JSON.stringify(accounts);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(null); }, [contextRevision, actorUserId]);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === customerSelection) ?? null,
    [accounts, customerSelection],
  );

  useEffect(() => {
    if (draft) draftRef.current?.focus();
  }, [draft]);

  useEffect(() => {
    if (success && !saving) customerRef.current?.focus();
  }, [saving, success]);

  if (readonly) {
    return <div className="quick-capture-readonly">当前为只读视图，不能创建正式记录。</div>;
  }

  const invalidateDraft = () => {
    setDraft(null);
    setError('');
    setSuccess('');
  };

  const inputFor = (patch: Partial<Pick<QuickCaptureInput, 'title' | 'localDateTime'>> = {}): QuickCaptureInput => {
    const customer: QuickCaptureInput['customer'] = customerSelection === NEW_CUSTOMER
      ? { mode: 'new', name: newCustomerName }
      : selectedAccount
        ? { mode: 'existing', id: selectedAccount.id, name: selectedAccount.name }
        : { mode: 'existing', id: '', name: '' };
    const matter = selectedAccount?.opportunities.find((candidate) => candidate.id === matterId);
    const person = selectedAccount?.persons.find((candidate) => candidate.id === personId);
    if ((matterId && !matter) || (personId && !person)) throw new Error('关联商机或联系人已不可用，请刷新后重新选择。');
    return {
      customer,
      title: patch.title ?? title,
      localDateTime: patch.localDateTime ?? localDateTime,
      timeZone,
      matter: matter ? { id: matter.id, name: matter.name } : null,
      person: person ? { id: person.id, name: person.name } : null,
      requiresConfirmation,
      confirmationDueLocalDateTime,
      actorUserId,
    };
  };

  const preview = (patch?: Partial<Pick<QuickCaptureInput, 'title' | 'localDateTime'>>) => {
    try {
      const nextDraft = buildQuickCaptureDraft(inputFor(patch));
      setDraft(nextDraft);
      setError('');
      setSuccess('');
    } catch (cause) {
      setDraft(null);
      setError(cause instanceof Error ? cause.message : '无法生成确认草稿');
    }
  };

  const onPreview = (event: FormEvent) => {
    event.preventDefault();
    preview();
  };

  const parseAndPreview = () => {
    const parsed = parseNaturalQuickCapture(naturalText, { timeZone });
    if (!parsed.ok) {
      setDraft(null);
      setError(parsed.error);
      return;
    }
    setTitle(parsed.title);
    setLocalDateTime(parsed.localDateTime);
    preview({ title: parsed.title, localDateTime: parsed.localDateTime });
  };

  const confirm = async () => {
    if (!draft || saving || sending.current) return;
    const session = api.getToken();
    const current = () => mounted.current && api.getToken() === session;
    sending.current = true;
    setSaving(true);
    setError('');
    try {
      inputFor(); // A vanished association must not be silently saved as customer-only.
      const result = await saveAndRefreshQuickCaptureDraft(draft, api.quickCapture, async () => { if (current()) await onSaved(); });
      if (!current()) return;
      setDraft(null);
      setTitle('');
      setLocalDateTime('');
      setMatterId('');
      setPersonId('');
      setRequiresConfirmation(false);
      setConfirmationDueLocalDateTime('');
      setNaturalText('');
      setNewCustomerName('');
      setCustomerSelection('');
      setSuccess('已保存为正式下一步。');
      setRefreshWarning(result.refreshed ? '' : '正式记录已保存，但客户列表刷新失败。');
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '保存失败，请使用同一草稿重试');
    } finally {
      sending.current = false;
      if (current()) setSaving(false);
    }
  };

  const retryRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onSaved();
      setRefreshWarning('');
    } catch {
      setRefreshWarning('正式记录已保存，但客户列表仍未刷新。');
    } finally {
      setRefreshing(false);
    }
  };

  const changeCustomer = (value: string) => {
    setCustomerSelection(value);
    setMatterId('');
    setPersonId('');
    invalidateDraft();
  };

  return (
    <div className="quick-capture">
      {selectedAccount && matterId ? <p className="personal-goal">当前商机：{selectedAccount.opportunities.find(matter => matter.id === matterId)?.name ?? '关联已失效，请重新选择'}</p> : null}
      <fieldset className="quick-capture-editor" disabled={saving} aria-busy={saving}>
        <section className="quick-capture-natural" aria-label="自然语言快速填写">
          <label htmlFor="quick-natural">可选：先写一句话</label>
          <div className="quick-capture-inline">
            <textarea
              id="quick-natural"
              value={naturalText}
              placeholder="例如：周四 15:00 与客户交流方案"
              rows={2}
              maxLength={QUICK_CAPTURE_NATURAL_TEXT_MAX_LENGTH}
              onChange={(event) => { setNaturalText(event.target.value); invalidateDraft(); }}
            />
            <button className="btn ghost" type="button" onClick={parseAndPreview}>解析并生成草稿</button>
          </div>
          <small>解析只填写下面的确认草稿，不会创建客户或下一步。</small>
        </section>

        <form
          data-quick-capture-form="true"
          className="quick-capture-form"
          onSubmit={onPreview}
          aria-describedby={error ? 'quick-capture-error' : undefined}
        >
          <div className="quick-capture-grid">
            <label className="quick-capture-field">
              客户<span aria-hidden="true"> *</span>
              <select ref={customerRef} required value={customerSelection} onChange={(event) => changeCustomer(event.target.value)}>
                <option value="">请选择客户</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                <option value={NEW_CUSTOMER}>＋ 新建客户</option>
              </select>
            </label>
            {customerSelection === NEW_CUSTOMER && (
              <label className="quick-capture-field" data-customer-mode="new">
                客户名称<span aria-hidden="true"> *</span>
                <input
                  required
                  value={newCustomerName}
                  maxLength={CUSTOMER_NAME_MAX_LENGTH}
                  placeholder="输入新客户名称"
                  onChange={(event) => { setNewCustomerName(event.target.value); invalidateDraft(); }}
                />
              </label>
            )}
            <label className="quick-capture-field">
              下一步<span aria-hidden="true"> *</span>
              <input
                required
                value={title}
                maxLength={QUICK_CAPTURE_TITLE_MAX_LENGTH}
                placeholder="例如：与客户交流方案"
                onChange={(event) => { setTitle(event.target.value); invalidateDraft(); }}
              />
            </label>
            <label className="quick-capture-field">
              时间<span aria-hidden="true"> *</span>
              <input
                required
                type="datetime-local"
                value={localDateTime}
                onChange={(event) => { setLocalDateTime(event.target.value); invalidateDraft(); }}
              />
            </label>
          </div>

          {accounts.length === 0 && customerSelection === NEW_CUSTOMER && (
            <p className="quick-capture-hint">还没有客户，保存时会在同一事务内创建客户和下一步。</p>
          )}

          <details className="quick-capture-details">
            <summary>事项、联系人和确认要求（可选）</summary>
            {selectedAccount ? (
              <div className="quick-capture-grid">
                <label className="quick-capture-field">
                  事项
                  <select value={matterId} onChange={(event) => { setMatterId(event.target.value); invalidateDraft(); }}>
                    <option value="">不关联事项</option>
                    {selectedAccount.opportunities.map((matter) => (
                      <option key={matter.id} value={matter.id}>{matter.name}</option>
                    ))}
                  </select>
                </label>
                <label className="quick-capture-field">
                  联系人
                  <select value={personId} onChange={(event) => { setPersonId(event.target.value); invalidateDraft(); }}>
                    <option value="">不关联联系人</option>
                    {selectedAccount.persons.map((person) => (
                      <option key={person.id} value={person.id}>{person.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : <p className="quick-capture-hint">选择已有客户后可补充事项和联系人；新客户暂不需要。</p>}
            <label className="quick-capture-check">
              <input
                type="checkbox"
                checked={requiresConfirmation}
                onChange={(event) => { setRequiresConfirmation(event.target.checked); invalidateDraft(); }}
              />
              到时间前需要再次确认
            </label>
            {requiresConfirmation && (
              <label className="quick-capture-field">
                确认截止时间<span aria-hidden="true"> *</span>
                <input
                  required
                  type="datetime-local"
                  value={confirmationDueLocalDateTime}
                  onChange={(event) => { setConfirmationDueLocalDateTime(event.target.value); invalidateDraft(); }}
                />
              </label>
            )}
          </details>

          <div className="commercial-shell-actions">
            <button className="btn primary" type="submit">生成确认草稿</button>
          </div>
        </form>
      </fieldset>

      {draft && (
        <section
          ref={draftRef}
          className="quick-capture-draft"
          data-quick-capture-draft="true"
          aria-label="确认草稿"
          aria-live="polite"
          tabIndex={-1}
        >
          <div><strong>目标对象</strong><span>{draft.summary.customerName} · 下一步</span></div>
          <div><strong>字段</strong><span>{draft.summary.title} · {draft.summary.localDateTime.replace('T', ' ')} · {draft.summary.timeZone}</span></div>
          <div><strong>关联</strong><span>{draft.summary.matterName ?? '客户级（无事项）'}{draft.summary.personName ? ` · ${draft.summary.personName}` : ''}</span></div>
          <div><strong>正式动作</strong><span>{draft.summary.actions.join(' + ')}</span></div>
          {draft.summary.confirmationDueLocalDateTime && (
            <div><strong>确认截止</strong><span>{draft.summary.confirmationDueLocalDateTime.replace('T', ' ')}</span></div>
          )}
          <p>只有点击“确认并保存”后，才会写入正式数据。</p>
          <div className="commercial-shell-actions">
            <button className="btn primary" type="button" disabled={saving} onClick={() => void confirm()}>
              {saving ? '保存中…' : '确认并保存'}
            </button>
            <button className="btn ghost" type="button" disabled={saving} onClick={() => setDraft(null)}>返回修改</button>
          </div>
        </section>
      )}

      {error && <p id="quick-capture-error" className="quick-capture-message error" role="alert">{error}</p>}
      {success && <p className="quick-capture-message success" role="status">{success}</p>}
      {refreshWarning && (
        <div className="quick-capture-message error" role="alert">
          {refreshWarning}{' '}
          <button className="btn ghost sm" type="button" disabled={refreshing} onClick={() => void retryRefresh()}>
            {refreshing ? '刷新中…' : '重新刷新列表'}
          </button>
        </div>
      )}
    </div>
  );
}
