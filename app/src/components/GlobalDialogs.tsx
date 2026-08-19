import type { ComponentProps, Dispatch } from 'react';
import type { Account } from '../types';
import type { SessionLease } from '../lib/sessionLifecycle';
import {
  getGlobalDialogVisibility,
  type AppShellSurface,
  type AppShellUiAction,
  type AppShellUiState,
  type SettableGlobalDialog,
} from '../lib/appShellUi';
import { AiSettings } from './AiSettings';
import { HelpManual } from './HelpManual';
import { InboxPanel } from './InboxPanel';
import { IntelCapture } from './IntelCapture';
import { McpAccess } from './McpAccess';
import { RepairPanel } from './RepairPanel';
import { TeamBilling } from './TeamBilling';
import { WeComSettings } from './WeComSettings';

export type GlobalInboxProps = Omit<ComponentProps<typeof InboxPanel>, 'onClose'>;
export type GlobalIntelProps = Omit<ComponentProps<typeof IntelCapture>, 'onClose'>;
export type GlobalRepairProps = Omit<ComponentProps<typeof RepairPanel>, 'target' | 'accounts' | 'onClose' | 'onEditOpportunity'>;

export function GlobalDialogs({
  surface,
  state,
  dispatch,
  sessionLease,
  readonly,
  role,
  accounts,
  inbox,
  intel,
  repair,
  onEditRepairOpportunity,
}: {
  surface: AppShellSurface;
  state: AppShellUiState;
  dispatch: Dispatch<AppShellUiAction>;
  sessionLease: SessionLease;
  readonly: boolean;
  role: string;
  accounts: Account[];
  inbox: GlobalInboxProps;
  intel?: GlobalIntelProps;
  repair: GlobalRepairProps;
  onEditRepairOpportunity?: () => void;
}) {
  const visible = getGlobalDialogVisibility(state, readonly, surface);
  const closeDialog = (dialog: SettableGlobalDialog) => {
    if (sessionLease.isCurrent()) dispatch({ type: 'SET_DIALOG', dialog, open: false });
  };
  const repairTarget = state.repairTarget;
  const inboxDialog = visible.inbox ? <InboxPanel {...inbox} onClose={() => closeDialog('inbox')} /> : null;
  const intelDialog = visible.intel && intel ? (
    <IntelCapture
      {...intel}
      onClose={() => { if (sessionLease.isCurrent()) dispatch({ type: 'CLOSE_INTEL' }); }}
      onEnterAccount={intel.onEnterAccount ? (accountId) => {
        if (!sessionLease.isCurrent()) return;
        dispatch({ type: 'CLOSE_INTEL' });
        intel.onEnterAccount?.(accountId);
      } : undefined}
    />
  ) : null;
  const teamDialog = visible.team ? <TeamBilling role={role} onClose={() => closeDialog('team')} /> : null;
  const aiSettingsDialog = visible.aiSettings ? <AiSettings role={role} sessionLease={sessionLease} onClose={() => closeDialog('aiSettings')} /> : null;
  const wecomSettingsDialog = visible.wecomSettings ? <WeComSettings role={role} onClose={() => closeDialog('wecomSettings')} /> : null;
  const helpDialog = visible.help ? <HelpManual onClose={() => closeDialog('help')} /> : null;
  const mcpAccessDialog = visible.mcpAccess ? <McpAccess onClose={() => closeDialog('mcpAccess')} /> : null;
  const repairDialog = visible.repair && repairTarget ? (
    <RepairPanel
      key={`${repairTarget.kind}:${repairTarget.kind === 'account' ? repairTarget.account.id : repairTarget.kind === 'opportunity' ? repairTarget.opportunity.id : repairTarget.record.id}`}
      {...repair}
      target={repairTarget}
      accounts={accounts}
      onClose={() => { if (sessionLease.isCurrent()) dispatch({ type: 'SET_REPAIR_TARGET', target: null }); }}
      onEditOpportunity={repairTarget.kind === 'opportunity' && onEditRepairOpportunity ? () => {
        if (!sessionLease.isCurrent()) return;
        dispatch({ type: 'SET_REPAIR_TARGET', target: null });
        onEditRepairOpportunity();
      } : undefined}
    />
  ) : null;

  return surface === 'hub' ? (
    <>
      {inboxDialog}
      {intelDialog}
      {teamDialog}
      {aiSettingsDialog}
      {wecomSettingsDialog}
      {helpDialog}
      {mcpAccessDialog}
      {repairDialog}
    </>
  ) : (
    <>
      {teamDialog}
      {aiSettingsDialog}
      {wecomSettingsDialog}
      {helpDialog}
      {mcpAccessDialog}
      {inboxDialog}
      {repairDialog}
    </>
  );
}
