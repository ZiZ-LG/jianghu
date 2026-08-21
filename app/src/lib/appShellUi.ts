import type { Account, Note, Opportunity, VisitNote } from '../types';

/** 录入情报时的挂靠上下文（客户/商机/可选焦点人）。 */
export interface VisitCaptureContext {
  accId: string;
  oppId: string;
  personId?: string;
}

export type RepairTarget =
  | { kind: 'account'; account: Account }
  | { kind: 'opportunity'; account: Account; opportunity: Opportunity }
  | { kind: 'visitNote'; record: VisitNote }
  | { kind: 'note'; record: Note };

export type GlobalDialog = 'inbox' | 'intel' | 'team' | 'aiSettings' | 'wecomSettings' | 'help' | 'mcpAccess';
export type SettableGlobalDialog = Exclude<GlobalDialog, 'intel'>;
export type AppShellSurface = 'hub' | 'workroom';

export interface AppShellUiState {
  dialogs: Record<GlobalDialog, boolean>;
  intelContext: VisitCaptureContext | null;
  repairTarget: RepairTarget | null;
}

export type AppShellUiAction =
  | { type: 'SET_DIALOG'; dialog: SettableGlobalDialog; open: boolean }
  | { type: 'OPEN_INTEL'; context: VisitCaptureContext | null }
  | { type: 'CLOSE_INTEL' }
  | { type: 'SET_REPAIR_TARGET'; target: RepairTarget | null }
  | { type: 'RESET_SESSION_TRANSIENT' };

export interface GlobalDialogVisibility extends Record<GlobalDialog, boolean> {
  repair: boolean;
}

export function createInitialAppShellUiState(): AppShellUiState {
  return {
    dialogs: {
      inbox: false,
      intel: false,
      team: false,
      aiSettings: false,
      wecomSettings: false,
      help: false,
      mcpAccess: false,
    },
    intelContext: null,
    repairTarget: null,
  };
}

export function appShellUiReducer(state: AppShellUiState, action: AppShellUiAction): AppShellUiState {
  switch (action.type) {
    case 'SET_DIALOG':
      return { ...state, dialogs: { ...state.dialogs, [action.dialog]: action.open } };
    case 'OPEN_INTEL':
      return {
        ...state,
        dialogs: { ...state.dialogs, intel: true },
        intelContext: action.context,
      };
    case 'CLOSE_INTEL':
      return {
        ...state,
        dialogs: { ...state.dialogs, intel: false },
        intelContext: null,
      };
    case 'SET_REPAIR_TARGET':
      return { ...state, repairTarget: action.target };
    case 'RESET_SESSION_TRANSIENT':
      return createInitialAppShellUiState();
  }
}

/**
 * Render-level visibility mirrors the existing entry guards. The workroom gains
 * the same WeCom settings reachability as the Hub, while viewer write surfaces
 * remain hidden even if stale UI state survives a session transition.
 */
export function getGlobalDialogVisibility(
  state: AppShellUiState,
  readonly: boolean,
  surface: AppShellSurface,
): GlobalDialogVisibility {
  const writable = !readonly;
  return {
    inbox: writable && state.dialogs.inbox,
    intel: writable && surface === 'hub' && state.dialogs.intel,
    team: state.dialogs.team,
    aiSettings: writable && state.dialogs.aiSettings,
    wecomSettings: writable && state.dialogs.wecomSettings,
    help: state.dialogs.help,
    mcpAccess: writable && state.dialogs.mcpAccess,
    repair: writable && Boolean(state.repairTarget),
  };
}
