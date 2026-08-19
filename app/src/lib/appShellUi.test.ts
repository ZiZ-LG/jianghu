import { describe, expect, it } from 'vitest';
import {
  appShellUiReducer,
  createInitialAppShellUiState,
  getGlobalDialogVisibility,
  type GlobalDialog,
} from './appShellUi';
import { seedAccount } from '../data/seed';

function openAllDialogs() {
  return (['inbox', 'intel', 'team', 'aiSettings', 'wecomSettings', 'help', 'mcpAccess'] as GlobalDialog[])
    .reduce(
      (state, dialog) => appShellUiReducer(state, { type: 'SET_DIALOG', dialog, open: true }),
      createInitialAppShellUiState(),
    );
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
});

describe('getGlobalDialogVisibility', () => {
  it('keeps viewer write dialogs hidden while preserving read-only team/help surfaces', () => {
    const visibility = getGlobalDialogVisibility(openAllDialogs(), true, 'hub');

    expect(visibility).toMatchObject({
      inbox: false,
      intel: false,
      team: true,
      aiSettings: false,
      wecomSettings: false,
      help: true,
      mcpAccess: false,
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
});
