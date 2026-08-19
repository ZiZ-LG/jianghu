import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { seedAccount } from '../data/seed';
import type { Note, VisitNote } from '../types';
import { createSessionGuard, createSessionLease } from '../lib/sessionLifecycle';
import {
  appShellUiReducer,
  createInitialAppShellUiState,
  type AppShellUiAction,
  type AppShellUiState,
  type SettableGlobalDialog,
  type RepairTarget,
} from '../lib/appShellUi';
import { AiSettings } from './AiSettings';
import {
  GlobalDialogs,
  type GlobalInboxProps,
  type GlobalRepairProps,
} from './GlobalDialogs';
import { HelpManual } from './HelpManual';
import { InboxPanel } from './InboxPanel';
import { IntelCapture } from './IntelCapture';
import { McpAccess } from './McpAccess';
import { RepairPanel } from './RepairPanel';
import { TeamBilling } from './TeamBilling';
import { WeComSettings } from './WeComSettings';

const allDialogs = (): AppShellUiState => {
  const standardDialogs = (['inbox', 'team', 'aiSettings', 'wecomSettings', 'help', 'mcpAccess'] as SettableGlobalDialog[])
    .reduce(
      (state, dialog) => appShellUiReducer(state, { type: 'SET_DIALOG', dialog, open: true }),
      createInitialAppShellUiState(),
    );
  return appShellUiReducer(standardDialogs, { type: 'OPEN_INTEL', context: null });
};
const testSessionGuard = createSessionGuard();
const testSessionLease = createSessionLease(testSessionGuard, testSessionGuard.begin('test-token'), () => 'test-token');

function childrenOf(tree: ReturnType<typeof GlobalDialogs>): ReactElement[] {
  return Children.toArray((tree.props as { children?: ReactNode }).children)
    .filter(isValidElement) as ReactElement[];
}

function childOfType(children: ReactElement[], type: ReactElement['type']): ReactElement {
  const child = children.find((item) => item.type === type);
  expect(child).toBeDefined();
  return child!;
}

function renderDialogs({
  state = allDialogs(),
  surface = 'hub',
  readonly = false,
  dispatch = vi.fn(),
  sessionLease = testSessionLease,
  intel,
  onEditRepairOpportunity,
}: {
  state?: AppShellUiState;
  surface?: 'hub' | 'workroom';
  readonly?: boolean;
  dispatch?: (action: AppShellUiAction) => void;
  sessionLease?: Parameters<typeof GlobalDialogs>[0]['sessionLease'];
  intel?: Parameters<typeof GlobalDialogs>[0]['intel'];
  onEditRepairOpportunity?: () => void;
} = {}) {
  const tree = GlobalDialogs({
    surface,
    state,
    dispatch,
    sessionLease,
    readonly,
    role: 'owner',
    accounts: [seedAccount],
    inbox: {} as GlobalInboxProps,
    intel,
    repair: {} as GlobalRepairProps,
    onEditRepairOpportunity,
  });
  return { children: childrenOf(tree), dispatch };
}

describe('GlobalDialogs', () => {
  it('assembles every Hub dialog once and dispatches the standard close actions', () => {
    const state = appShellUiReducer(allDialogs(), {
      type: 'SET_REPAIR_TARGET',
      target: { kind: 'account', account: seedAccount },
    });
    const dispatch = vi.fn();
    const { children } = renderDialogs({
      state,
      dispatch,
      intel: { onDone: vi.fn() },
    });

    expect(children.map((child) => child.type)).toEqual([
      InboxPanel,
      IntelCapture,
      TeamBilling,
      AiSettings,
      WeComSettings,
      HelpManual,
      McpAccess,
      RepairPanel,
    ]);

    const expected = [
      [InboxPanel, 'inbox'],
      [TeamBilling, 'team'],
      [AiSettings, 'aiSettings'],
      [WeComSettings, 'wecomSettings'],
      [HelpManual, 'help'],
      [McpAccess, 'mcpAccess'],
    ] as const;
    for (const [type, dialog] of expected) {
      (childOfType(children, type).props as { onClose: () => void }).onClose();
      expect(dispatch).toHaveBeenLastCalledWith({ type: 'SET_DIALOG', dialog, open: false });
    }
    expect((childOfType(children, AiSettings).props as { sessionLease: unknown }).sessionLease).toBe(testSessionLease);
  });

  it('keeps Intel Hub-only and closes it before entering an account', () => {
    const dispatch = vi.fn();
    const onEnterAccount = vi.fn();
    const { children } = renderDialogs({
      dispatch,
      intel: { onDone: vi.fn(), onEnterAccount },
    });
    const intel = childOfType(children, IntelCapture);
    const props = intel.props as { onClose: () => void; onEnterAccount: (accountId: string) => void };

    props.onClose();
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'CLOSE_INTEL' });

    dispatch.mockClear();
    props.onEnterAccount('acc-next');
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_INTEL' });
    expect(onEnterAccount).toHaveBeenCalledWith('acc-next');

    expect(renderDialogs({
      surface: 'workroom',
      intel: { onDone: vi.fn(), onEnterAccount },
    }).children.some((child) => child.type === IntelCapture)).toBe(false);
  });

  it('ignores dialog callbacks retained by an expired rendered session', () => {
    const guard = createSessionGuard();
    let token: string | null = 'token-a';
    const expiredLease = createSessionLease(guard, guard.begin(token), () => token);
    token = 'token-b';
    guard.begin(token);
    const dispatch = vi.fn();
    const { children } = renderDialogs({ dispatch, sessionLease: expiredLease, intel: { onDone: vi.fn() } });

    (childOfType(children, AiSettings).props as { onClose: () => void }).onClose();
    (childOfType(children, IntelCapture).props as { onClose: () => void }).onClose();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('clears an opportunity repair before handing off to the editor', () => {
    const opportunity = seedAccount.opportunities[0];
    expect(opportunity).toBeDefined();
    const target: RepairTarget = { kind: 'opportunity', account: seedAccount, opportunity };
    const state = appShellUiReducer(allDialogs(), { type: 'SET_REPAIR_TARGET', target });
    const dispatch = vi.fn();
    const onEditRepairOpportunity = vi.fn();
    const { children } = renderDialogs({ state, dispatch, onEditRepairOpportunity });
    const repair = childOfType(children, RepairPanel);
    const props = repair.props as { onClose: () => void; onEditOpportunity: () => void };

    expect(String(repair.key)).toContain('opportunity');
    expect(String(repair.key)).toContain(opportunity.id);
    props.onClose();
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'SET_REPAIR_TARGET', target: null });

    dispatch.mockClear();
    props.onEditOpportunity();
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_REPAIR_TARGET', target: null });
    expect(onEditRepairOpportunity).toHaveBeenCalledTimes(1);
  });

  it('uses stable repair keys for account and record targets', () => {
    const targets: Array<[RepairTarget, string, string]> = [
      [{ kind: 'account', account: seedAccount }, 'account', seedAccount.id],
      [{ kind: 'visitNote', record: { id: 'visit-1' } as VisitNote }, 'visitNote', 'visit-1'],
      [{ kind: 'note', record: { id: 'note-1' } as Note }, 'note', 'note-1'],
    ];

    for (const [target, kind, id] of targets) {
      const state = appShellUiReducer(allDialogs(), { type: 'SET_REPAIR_TARGET', target });
      const repair = childOfType(renderDialogs({ state }).children, RepairPanel);
      const rerendered = childOfType(renderDialogs({ state }).children, RepairPanel);
      expect(repair.key).toBe(rerendered.key);
      expect(String(repair.key)).toContain(kind);
      expect(String(repair.key)).toContain(id);
    }
  });

  it('keeps viewer write dialogs absent on both authenticated surfaces', () => {
    const stateWithStaleRepair = appShellUiReducer(allDialogs(), {
      type: 'SET_REPAIR_TARGET',
      target: { kind: 'account', account: seedAccount },
    });

    for (const surface of ['hub', 'workroom'] as const) {
      const { children } = renderDialogs({ surface, readonly: true, state: stateWithStaleRepair });
      expect(children.map((child) => child.type)).toEqual([TeamBilling, HelpManual]);
    }
  });
});
