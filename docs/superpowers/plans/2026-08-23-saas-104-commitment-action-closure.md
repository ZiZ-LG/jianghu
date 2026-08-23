# SAAS-104 Commitment Action Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the governed Today read model into a safe, auditable confirmation and follow-up loop for confirm, decline, reschedule, complete, cancel, explicit missed, and linked next Commitment actions.

**Architecture:** Keep `PlanAction` as the single physical Commitment source and reuse the existing `/api/commands/commitment` command path. The browser derives a bounded action draft only for `core.today` items, binds every existing-row command to the item’s exact `version` and `scheduleVersion`, submits with one stable idempotency key, runtime-validates the receipt, then reloads Today and the shared account state. No action mutates optimistically, no provider-authored item grants a write, and no overdue read automatically changes `executionStatus`.

**Tech Stack:** React 19, TypeScript strict mode, Vite, Zod domain contracts, Fastify, Prisma, Vitest, SQLite/PostgreSQL CI.

## Global Constraints

- Work only in `/Volumes/PowerData/江湖APP/.worktrees/g3-lightweight-personal-crm` on `codex/g3-lightweight-personal-crm`.
- Do not reset, checkout, rebase, switch branches, merge `main`, deploy, or modify production data.
- Do not modify `app/package.json`, `app/package-lock.json`, `app/vite.config.*`, `app/dist/**`, `docker-compose.yml`, main-site navigation, cross-site entry points, or any “自我修养” path reserved by the owner.
- Do not add schema or migration changes; SAAS-104 consumes the existing Commitment command and audit authority.
- Every write remains tenant-scoped, effective-scope checked, viewer-blocked, CAS-bound, idempotent, and audited by the existing server command runner.
- `past_due` remains a derived Today condition. Only an explicit user-confirmed `MARK_COMMITMENT_MISSED` command may set `executionStatus=missed`.
- Reschedule keeps the same Commitment ID, increments `scheduleVersion`, resets confirmation, and preserves the previous confirmation as stale revision metadata.
- Only `providerKey=core.today` with a revision-bound Commitment target may expose Commitment mutation controls. Matter-without-next keeps its existing non-mutating suggestion during this task.
- A command success followed by refresh failure is reported as “saved, refresh failed”; the client must not manufacture a new command or silently resubmit different payload under the same key.
- No G64111, PDE, WorkBuddy, relationship-provider, G4, SAAS-105, or SAAS-106 implementation is included.

---

### Task 1: Fail-closed Today action domain adapter

**Files:**
- Create: `app/src/lib/commitmentActions.ts`
- Create: `app/src/lib/commitmentActions.test.ts`
- Reuse: `app/src/lib/quickCapture.ts`

**Interfaces:**
- Consumes: `InterventionItem`, `CommitmentCommand`, `CommitmentCommandSchema`, `QUICK_CAPTURE_TITLE_MAX_LENGTH`, `zonedLocalDateTimeToUtc`, and `createOpaqueEntityId`.
- Produces: `availableTodayCommitmentActions(item)`, `buildTodayCommitmentActionDraft(input, dependencies?)`, `submitTodayCommitmentActionDraft(draft, submit)`, and `saveAndRefreshTodayCommitmentActionDraft(draft, submit, refreshToday, refreshState)`.

- [ ] **Step 1: Write failing availability tests**

```ts
expect(availableTodayCommitmentActions(pendingItem).map((action) => action.kind)).toEqual([
  'confirm', 'decline', 'reschedule', 'cancel',
]);
expect(availableTodayCommitmentActions(overdueItem).map((action) => action.kind)).toEqual([
  'complete', 'reschedule', 'mark_missed', 'cancel',
]);
expect(availableTodayCommitmentActions({ ...pendingItem, providerKey: 'vendor.signal' })).toEqual([]);
expect(availableTodayCommitmentActions(matterWithoutNextItem)).toEqual([]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd app && npm test -- --run src/lib/commitmentActions.test.ts`

Expected: FAIL because `commitmentActions.ts` and its exports do not exist.

- [ ] **Step 3: Implement the action allowlist**

```ts
export type TodayCommitmentActionKind =
  | 'confirm' | 'decline' | 'reschedule' | 'complete'
  | 'cancel' | 'mark_missed' | 'create_next';

export function availableTodayCommitmentActions(item: InterventionItem): TodayCommitmentAction[] {
  if (item.providerKey !== 'core.today' || item.target.entityKind !== 'commitment') return [];
  if (item.reasonCode === 'confirmation_due') return CONFIRMATION_ACTIONS;
  if (item.reasonCode === 'commitment_due') {
    return item.time.relation === 'overdue' ? OVERDUE_ACTIONS : FOLLOW_UP_ACTIONS;
  }
  if (item.reasonCode === 'commitment_completed'
    && item.suggestedAction.commandType === 'CREATE_NEXT_COMMITMENT') return CREATE_NEXT_ACTIONS;
  return [];
}
```

The arrays are immutable constants with Chinese labels and exact command types. No unknown provider or reason code receives an executable action.

- [ ] **Step 4: Write failing command-builder tests**

```ts
expect(buildTodayCommitmentActionDraft({ item: pendingItem, kind: 'confirm', occurredAtUtc: NOW }, deps).command)
  .toMatchObject({
    type: 'CONFIRM_COMMITMENT', customerId: 'customer-1', commitmentId: 'commitment-1',
    baseVersion: 2, expectedScheduleVersion: 3, confirmedAtUtc: NOW,
  });

expect(buildTodayCommitmentActionDraft({
  item: pendingItem,
  kind: 'reschedule',
  schedule: {
    isAllDay: false,
    localDateTime: '2026-08-27T15:00',
    localDate: '',
    timeZone: 'Asia/Shanghai',
    requiresConfirmation: true,
    confirmationDueLocalDateTime: '2026-08-26T15:00',
  },
}, deps).command).toMatchObject({
  type: 'RESCHEDULE_COMMITMENT', baseVersion: 2, expectedScheduleVersion: 3,
  schedule: { scheduledAtUtc: '2026-08-27T07:00:00.000Z', requiresConfirmation: true },
});

expect(() => buildTodayCommitmentActionDraft({
  item: dueTodayItem,
  kind: 'mark_missed',
  occurredAtUtc: NOW,
}, deps)).toThrow('只有已经逾期的下一步才能标记错过');
```

Cover timed schedules, all-day local dates, DST nonexistent/ambiguous time rejection, confirmation deadline ordering, cancellation reason trimming, stable next-Commitment ID, exact previous version linking, and unsupported action/reason combinations.

- [ ] **Step 5: Implement strict action draft construction**

```ts
export interface TodayCommitmentActionDraft {
  action: TodayCommitmentAction;
  command: CommitmentCommand;
  idempotencyKey: string;
  summary: { actionLabel: string; targetLabel: string; scheduleLabel: string | null };
}

export function buildTodayCommitmentActionDraft(
  input: BuildTodayCommitmentActionInput,
  dependencies: BuildDependencies = DEFAULT_BUILD_DEPENDENCIES,
): TodayCommitmentActionDraft {
  const allowed = availableTodayCommitmentActions(input.item).find(({ kind }) => kind === input.kind);
  if (!allowed) throw new Error('当前提醒不允许该操作，请刷新后重试');
  const command = CommitmentCommandSchema.parse(buildCommandFromExactTarget(input, dependencies));
  return {
    action: allowed,
    command,
    idempotencyKey: dependencies.createIdempotencyKey(),
    summary: buildSummary(input, allowed),
  };
}
```

`CREATE_NEXT_COMMITMENT` creates a new `follow_up` Commitment owned by the current actor, inherits only `customerId` and optional `matterId`, sets `personId=null`, and uses `source=manual_today`. It never copies provider prose into a formal field.

- [ ] **Step 6: Write and implement saved-versus-refresh-result tests**

```ts
await expect(saveAndRefreshTodayCommitmentActionDraft(
  draft,
  submit,
  async () => { throw new Error('today refresh failed'); },
  async () => undefined,
)).resolves.toMatchObject({ saved: true, todayRefreshed: false, stateRefreshed: true });
expect(submit).toHaveBeenCalledTimes(1);
expect(submit).toHaveBeenCalledWith(draft.command, draft.idempotencyKey);
```

The helper submits once and uses `Promise.allSettled` for the two post-commit reads. Refresh errors never change the saved result or idempotency key.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `cd app && npm test -- --run src/lib/commitmentActions.test.ts src/lib/quickCapture.test.ts`

Expected: both files pass with zero failures.

---

### Task 2: Runtime-validated Commitment command client

**Files:**
- Modify: `app/src/api.ts`
- Modify: `app/src/api.test.ts`

**Interfaces:**
- Consumes: `CommitmentCommand`, `CommitmentCommandReceiptSchema`, and the existing retry-safe `commandReq`.
- Produces: `api.commitment(command, idempotencyKey)` that returns only a runtime-valid, identity-matched receipt.

- [ ] **Step 1: Add failing malformed/mismatched receipt tests**

```ts
await expect(api.commitment(confirmCommand, 'confirm-key'))
  .rejects.toMatchObject({ code: 'invalid_response', retryable: false });

await expect(api.commitment(confirmCommand, 'wrong-target-key'))
  .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
```

The first response omits `replayed`; the second changes `commitmentId`, `customerId`, `version`, or `scheduleVersion` while returning HTTP 200.

- [ ] **Step 2: Run the API test and verify RED**

Run: `cd app && npm test -- --run src/api.test.ts`

Expected: the new assertions fail because `api.commitment` currently trusts the typed HTTP body.

- [ ] **Step 3: Implement command-specific receipt validation**

```ts
function parseCommitmentResponse(raw: unknown, command: CommitmentCommand) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalidCommitmentResponse();
  const { replayed, ...receiptValue } = raw as Record<string, unknown>;
  if (typeof replayed !== 'boolean') throw invalidCommitmentResponse();
  const parsed = CommitmentCommandReceiptSchema.safeParse(receiptValue);
  if (!parsed.success || !receiptMatchesCommand(parsed.data, command)) {
    throw invalidCommitmentResponse(parsed.success ? undefined : parsed.error);
  }
  return { ...parsed.data, replayed };
}
```

For existing-row commands, require exact Commitment/Customer IDs, `version=baseVersion+1`, and unchanged `scheduleVersion` except `RESCHEDULE_COMMITMENT`, which must return `expectedScheduleVersion+1`. For `CREATE_NEXT_COMMITMENT`, require the generated new ID, inherited Customer/Matter, and exact `linkedFromCommitmentId`.

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `cd app && npm test -- --run src/api.test.ts`

Expected: retry-key and malformed/mismatched success-receipt cases all pass.

---

### Task 3: Explicit confirmation editor and Today integration

**Files:**
- Create: `app/src/components/CommitmentActionEditor.tsx`
- Create: `app/src/components/CommitmentActionEditor.test.ts`
- Modify: `app/src/components/TodayPanel.tsx`
- Modify: `app/src/components/TodayPanel.test.ts`
- Modify: `app/src/components/CommercialShell.tsx`
- Modify: `app/src/components/CommercialShell.test.ts`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: the Task 1 adapter and Task 2 validated client.
- Produces: a keyboard-accessible action editor, revision-bound action buttons, readonly suppression, success/error feedback, and post-command Today/state reload.

- [ ] **Step 1: Write failing static surface tests**

```ts
expect(renderToday({ readonly: false })).toContain('data-today-action="confirm"');
expect(renderToday({ readonly: false })).toContain('data-today-action="reschedule"');
expect(renderToday({ readonly: true })).not.toContain('data-today-action=');
expect(renderEditor('cancel')).toContain('确认取消');
expect(renderEditor('reschedule')).toContain('type="datetime-local"');
expect(renderEditor('mark_missed')).toContain('这会把正式状态标记为“已错过”');
```

Also assert that an upcoming item has no `mark_missed`, unknown providers have no command buttons, destructive actions use an explicit second confirmation surface, form controls have labels, and all buttons are `type=button` or submit within the editor form.

- [ ] **Step 2: Run focused component tests and verify RED**

Run: `cd app && npm test -- --run src/components/CommitmentActionEditor.test.ts src/components/TodayPanel.test.ts src/components/CommercialShell.test.ts`

Expected: FAIL because the editor and executable controls do not exist.

- [ ] **Step 3: Implement the explicit editor**

```tsx
export function CommitmentActionEditor({ item, action, actorUserId, saving, error, onCancel, onSubmit }: Props) {
  return (
    <section className="today-action-editor" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
      <h3 id={headingId}>{action.confirmLabel}</h3>
      <p>{item.context.customerName} · {item.title}</p>
      <p>提交时将核对 v{item.target.version} / schedule {item.target.scheduleVersion}；记录变化后不会覆盖。</p>
      <form onSubmit={submitValidatedDraft}>
        {action.kind === 'reschedule' && <ScheduleFields />}
        {action.kind === 'create_next' && <NextCommitmentFields />}
        {action.kind === 'cancel' && <CancellationReasonField />}
        <button className="btn primary" type="submit" disabled={saving}>{saving ? '提交中…' : action.confirmLabel}</button>
        <button className="btn ghost" type="button" disabled={saving} onClick={onCancel}>返回</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
```

Opening the editor moves focus into it; closing returns focus to the originating action button. Escape closes only while no command is in flight. Changing any form field discards a failed draft so a changed payload receives a new idempotency key.

- [ ] **Step 4: Integrate action controls with exact revision invalidation**

```tsx
<InterventionCard
  item={item}
  readonly={readonly}
  onAction={(action, origin) => setActiveAction({ item, action, origin })}
  onOpenSource={onOpenSource}
/>
```

`TodayPanel` accepts `actorUserId`, `readonly`, and `onDataChanged`. After a successful command it closes the editor, reports the formal result, reloads `/api/today`, and calls the existing shared-state reload callback. When a background Today refresh no longer contains the same target revision, it closes the editor and reports “记录已更新，请重新选择操作” instead of submitting stale content. A 409 uses the server message and triggers a read refresh; it never retries under a new key automatically.

- [ ] **Step 5: Add semantic responsive styles**

Use only existing semantic variables such as `--panel`, `--panel-2`, `--ink`, `--muted`, `--line`, `--accent`, `--accent-soft`, `--danger`, and `--hover`. All action controls have a minimum 44px target. At widths up to 640px, the editor and action groups stack without horizontal overflow; dark mode inherits semantic variables.

- [ ] **Step 6: Run focused component and helper tests and verify GREEN**

Run: `cd app && npm test -- --run src/lib/commitmentActions.test.ts src/components/CommitmentActionEditor.test.ts src/components/TodayPanel.test.ts src/components/CommercialShell.test.ts src/api.test.ts`

Expected: all focused files pass with zero failures.

---

### Task 4: Server-side Today-to-command closure evidence

**Files:**
- Create: `server/tests/today-action-closure.test.ts`
- Reuse without changing: `server/src/today.ts`
- Reuse without changing: `server/src/mutation/commitments.ts`

**Interfaces:**
- Consumes: `GET /api/today`, `POST /api/today/source`, and `POST /api/commands/commitment`.
- Produces: end-to-end proof that a Today target revision can drive only explicit audited commands and that stale reminders/sources fail closed.

- [ ] **Step 1: Write the closure integration test**

```ts
const pending = await today(context, NOW);
const target = findItem(pending, 'confirmation_due').target;

await command(context, 'confirm-stable-key', {
  type: 'CONFIRM_COMMITMENT',
  customerId: target.customerId,
  commitmentId: target.commitmentId,
  baseVersion: target.version,
  expectedScheduleVersion: target.scheduleVersion,
  confirmedAtUtc: NOW,
});

expect(await source(context, pendingSource)).toHaveStatus(404);
expect(await auditActions(context, target.commitmentId)).toContain('commitment_confirmed');
```

The same file covers confirm → reschedule → new pending revision, decline, complete, cancel, explicit missed, and complete → linked next. Before the explicit missed command, an overdue GET must leave the row `executionStatus=planned`. After reschedule, the previous source revision must return 404 and the reschedule audit must contain `previousConfirmation.stale=true`. Every event is asserted under the current tenant; a second tenant cannot use the captured IDs or revisions.

- [ ] **Step 2: Run the new server test and inspect actual gaps**

Run: `cd server && npm test -- --run tests/today-action-closure.test.ts`

Expected: PASS if the existing CORE-107/SAAS-103 seam is complete. If it fails, change only the smallest server behavior required by the documented SAAS-104 invariant, add the failure as a regression assertion, and rerun this exact file.

- [ ] **Step 3: Run affected server regressions**

Run: `cd server && npm test -- --run tests/commitment-command.test.ts tests/commitment-reminders.test.ts tests/today-read-model.test.ts tests/today-action-closure.test.ts tests/product-capabilities.test.ts`

Expected: all affected suites pass; no overdue read writes business state, and all command/audit/CAS/scope regressions remain green.

---

### Task 5: Full verification, browser QA, and atomic delivery

**Files:**
- Modify after implementation evidence only: `docs/商业版开发待办清单v1.md`
- Local ignored evidence only: `.gstack/qa-reports/**`

**Interfaces:**
- Consumes: the complete SAAS-104 tree.
- Produces: an implementation commit, exact-SHA remote CI evidence, and a separate checklist closure commit.

- [ ] **Step 1: Run the repository verification matrix**

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd ../g64111 && npm run typecheck && npm test
cd ../pde-kernel && npx tsc --noEmit && npm test
cd ../../app && npx tsc --noEmit && npm test
cd ../server && npx tsc --noEmit && npm test
cd server && npm run schema:postgres:check
cd server && env DATABASE_URL=file:./test.db npx prisma validate
git diff --check
```

Build the App to a new `/private/tmp/jianghu-saas104-build.*` directory so `app/dist/**` remains untouched. Confirm `git status --short` contains only SAAS-104 files and no protected/shared conflict path.

- [ ] **Step 2: Run browser QA against a disposable local database**

Verify desktop and 390×844/375×812 mobile layouts in light and dark themes. Exercise confirm, reschedule, decline, complete, cancel, overdue explicit missed, linked next, 409 stale revision, refresh failure message, readonly suppression, focus return, Escape, and zero console errors. Query the disposable database to prove each explicit action wrote one `AuditEvent`, reschedule incremented `scheduleVersion`, stale source returned 404, and viewing an overdue item alone left `executionStatus=planned`.

- [ ] **Step 3: Commit and push only the SAAS-104 implementation**

```bash
git add app/src/api.ts app/src/api.test.ts \
  app/src/lib/commitmentActions.ts app/src/lib/commitmentActions.test.ts \
  app/src/components/CommitmentActionEditor.tsx app/src/components/CommitmentActionEditor.test.ts \
  app/src/components/TodayPanel.tsx app/src/components/TodayPanel.test.ts \
  app/src/components/CommercialShell.tsx app/src/components/CommercialShell.test.ts \
  app/src/styles.css server/tests/today-action-closure.test.ts
git commit -m "feat(SAAS-104): close commitment action loop"
git push origin codex/g3-lightweight-personal-crm
```

Do not stage the plan/checklist checkpoint into the business implementation commit. Record the full implementation SHA and wait for its exact GitHub Actions run to finish with every job successful.

- [ ] **Step 4: Close the checklist in a separate docs commit**

Only after implementation CI is green, change `SAAS-104` to DONE and `SAAS-105` to READY, append exact local/remote evidence and rollback instructions, then commit and push:

```bash
git add docs/商业版开发待办清单v1.md
git commit -m "docs(SAAS-104): close commitment action gate"
git push origin codex/g3-lightweight-personal-crm
```

Wait for the docs commit’s exact SHA CI to finish successfully before starting SAAS-105.

---

## Self-Review

- **Spec coverage:** The plan covers all SAAS-104 states, `scheduleVersion`, stale confirmation revision, audit, explicit missed, Cao-manager confirmation failure, post-completion next step, tenant/scope/viewer/CAS/idempotency safety, responsive UI, refresh failure, and rollback boundaries.
- **Scope containment:** It adds no schema, migration, dependency, G64111/PDE logic, external notification, SAAS-105 page, G4 capability, production action, or shared build-file edit.
- **Type consistency:** All builders return the existing `CommitmentCommand`; all command receipts use the existing `CommitmentCommandReceiptSchema`; every Today mutation starts from an `InterventionItem.target` exact revision.
- **Placeholder scan:** The plan contains no deferred implementation placeholder; each code task names exact files, interfaces, tests, commands, and expected outcomes.
