import { describe, expect, it } from 'vitest';
import {
  appShellUiReducer,
  createInitialAppShellUiState,
  getGlobalDialogVisibility,
  type SettableGlobalDialog,
} from './appShellUi';
import { seedAccount } from '../data/seed';

function openAllDialogs() {
  const standardDialogs = (['inbox', 'team', 'aiSettings', 'wecomSettings', 'help', 'mcpAccess'] as SettableGlobalDialog[])
    .reduce(
      (state, dialog) => appShellUiReducer(state, { type: 'SET_DIALOG', dialog, open: true }),
      createInitialAppShellUiState(),
    );
  return appShellUiReducer(standardDialogs, { type: 'OPEN_INTEL', context: null });
}

describe('appShellUiReducer', () => {
  it('opens and closes global dialogs without changing unrelated dialog state', () => {
    const initial = createInitialAppShellUiState();
    const opened = appShellUiReducer(initial, { type: 'SET_DIALOG', dialog: 'inbox', open: true });
    const withHelp = appShellUiReducer(opened, { type: 'SET_DIALOG', dialog: 'help', open: true });
    const closed = appShellUiReducer(withHelp, { type: 'SET_DIALOG', dialog: 'inbox', open: false });

    expect(closed.dialogs.inbox).toBe(false);
    expect(closed.dialogs.help).toBe(true);
    expect(initial.dialogs.inbox).toBe(false);
  });

  it('clears every identity-bound dialog and repair target on logout', () => {
    const context = { accId: 'acc-1', oppId: 'opp-1', personId: 'person-1' };
    const opened = appShellUiReducer(openAllDialogs(), { type: 'OPEN_INTEL', context });
    const withRepair = appShellUiReducer(opened, {
      type: 'SET_REPAIR_TARGET',
      target: { kind: 'account', account: seedAccount },
    });
    const reset = appShellUiReducer(withRepair, { type: 'RESET_SESSION_TRANSIENT' });

    expect(Object.values(reset.dialogs)).toEqual([false, false, false, false, false, false, false]);
    expect(reset.intelContext).toBeNull();
    expect(reset.repairTarget).toBeNull();
  });

  it('preserves Intel context while open and clears it when closed', () => {
    const context = { accId: 'acc-1', oppId: 'opp-1', personId: 'person-1' };
    const opened = appShellUiReducer(
      createInitialAppShellUiState(),
      { type: 'OPEN_INTEL', context },
    );
    const closed = appShellUiReducer(opened, { type: 'CLOSE_INTEL' });

    expect(opened.dialogs.intel).toBe(true);
    expect(opened.intelContext).toEqual(context);
    expect(closed.dialogs.intel).toBe(false);
    expect(closed.intelContext).toBeNull();
  });

  it('sets and clears the repair target without changing dialog state', () => {
    const opened = appShellUiReducer(
      createInitialAppShellUiState(),
      { type: 'SET_DIALOG', dialog: 'help', open: true },
    );
    const withRepair = appShellUiReducer(opened, {
      type: 'SET_REPAIR_TARGET',
      target: { kind: 'account', account: seedAccount },
    });
    const cleared = appShellUiReducer(withRepair, { type: 'SET_REPAIR_TARGET', target: null });

    expect(withRepair.repairTarget).toEqual({ kind: 'account', account: seedAccount });
    expect(withRepair.dialogs.help).toBe(true);
    expect(cleared.repairTarget).toBeNull();
    expect(cleared.dialogs.help).toBe(true);
  });
});

describe('getGlobalDialogVisibility', () => {
  it('keeps viewer write dialogs hidden while preserving read-only team/help surfaces', () => {
    const stateWithStaleRepair = appShellUiReducer(openAllDialogs(), {
      type: 'SET_REPAIR_TARGET',
      target: { kind: 'account', account: seedAccount },
    });
    const visibility = getGlobalDialogVisibility(stateWithStaleRepair, true, 'hub');

    expect(visibility).toMatchObject({
      inbox: false,
      intel: false,
      team: true,
      aiSettings: false,
      wecomSettings: false,
      help: true,
      mcpAccess: false,
      repair: false,
    });
  });

  it('makes WeCom settings reachable on both authenticated writable surfaces', () => {
    const state = appShellUiReducer(
      createInitialAppShellUiState(),
      { type: 'SET_DIALOG', dialog: 'wecomSettings', open: true },
    );

    expect(getGlobalDialogVisibility(state, false, 'hub').wecomSettings).toBe(true);
    expect(getGlobalDialogVisibility(state, false, 'workroom').wecomSettings).toBe(true);
  });

  it('renders Intel capture only on the Hub surface', () => {
    const state = appShellUiReducer(
      createInitialAppShellUiState(),
      { type: 'OPEN_INTEL', context: null },
    );

    expect(getGlobalDialogVisibility(state, false, 'hub').intel).toBe(true);
    expect(getGlobalDialogVisibility(state, false, 'workroom').intel).toBe(false);
  });

  it('exposes every writable dialog and repair surface to a writable Hub user', () => {
    const withRepair = appShellUiReducer(openAllDialogs(), {
      type: 'SET_REPAIR_TARGET',
      target: { kind: 'account', account: seedAccount },
    });

    expect(getGlobalDialogVisibility(withRepair, false, 'hub')).toEqual({
      inbox: true,
      intel: true,
      team: true,
      aiSettings: true,
      wecomSettings: true,
      help: true,
      mcpAccess: true,
      repair: true,
    });
  });
});
