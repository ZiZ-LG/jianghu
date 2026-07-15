import type { VisitCaptureContext } from './momentFlowModel';
import type { InboxEvidence, InboxPerson, InboxProposal, InboxRel, InboxReminder, PatrolInfo } from '../api';

export interface SessionInbox {
  rels: InboxRel[];
  persons: InboxPerson[];
  proposals: InboxProposal[];
  reminders: InboxReminder[];
  evidences: InboxEvidence[];
  total: number;
  patrol?: PatrolInfo | null;
}

export const emptyInbox: SessionInbox = {
  rels: [], persons: [], proposals: [], reminders: [], evidences: [], total: 0,
};

export interface SessionInboxTicket {
  generation: number;
  token: string | null;
}

export interface SessionInboxGuard {
  begin: (token: string | null) => SessionInboxTicket;
  capture: () => SessionInboxTicket;
  isCurrent: (ticket: SessionInboxTicket, currentToken: string | null) => boolean;
}

/** Generation plus token prevents a previous tenant's delayed inbox response from committing into a later session. */
export function createSessionInboxGuard(): SessionInboxGuard {
  let generation = 0;
  let token: string | null = null;
  const capture = (): SessionInboxTicket => ({ generation, token });
  return {
    begin(nextToken) {
      generation += 1;
      token = nextToken;
      return capture();
    },
    capture,
    isCurrent(ticket, currentToken) {
      return ticket.generation === generation && ticket.token === token && ticket.token === currentToken;
    },
  };
}

export async function commitSessionInbox<T>(
  guard: SessionInboxGuard,
  ticket: SessionInboxTicket,
  request: Promise<T>,
  currentToken: () => string | null,
  commit: (value: T) => void,
): Promise<boolean> {
  const value = await request;
  if (!guard.isCurrent(ticket, currentToken())) return false;
  commit(value);
  return true;
}

export interface ClearedSessionUi {
  intelOpen: false;
  intelContext: VisitCaptureContext | null;
  inboxOpen: false;
  inbox: SessionInbox;
  syncErr: '';
}

/** Clear transient, identity-bound UI state before a different session can be restored. */
export function clearSessionUi(batchKeys: Map<unknown, unknown>): ClearedSessionUi {
  batchKeys.clear();
  return {
    intelOpen: false,
    intelContext: null,
    inboxOpen: false,
    inbox: emptyInbox,
    syncErr: '',
  };
}
