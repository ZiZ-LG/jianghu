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

export interface SessionTicket {
  generation: number;
  token: string | null;
}

export interface SessionGuard {
  begin: (token: string | null) => SessionTicket;
  capture: () => SessionTicket;
  isCurrent: (ticket: SessionTicket, currentToken: string | null) => boolean;
}

/** Generation plus token prevents any previous tenant response from committing into a later session. */
export function createSessionGuard(): SessionGuard {
  let generation = 0;
  let token: string | null = null;
  const capture = (): SessionTicket => ({ generation, token });
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

export type SessionReadResult<T> = { current: true; value: T } | { current: false };

export interface SessionLease {
  isCurrent(): boolean;
  run<T>(request: () => Promise<T>): Promise<SessionReadResult<T>>;
  commit(effect: () => void): boolean;
}

/** Avoid starting stale requests, then re-check after I/O before exposing their result to the current session. */
export async function runSessionRequest<T>(
  guard: SessionGuard,
  ticket: SessionTicket,
  request: () => Promise<T>,
  currentToken: () => string | null,
): Promise<SessionReadResult<T>> {
  if (!guard.isCurrent(ticket, currentToken())) return { current: false };
  const value = await request();
  if (!guard.isCurrent(ticket, currentToken())) return { current: false };
  return { current: true, value };
}

/** A render-bound capability: descendants can neither continue requests nor dispatch after the session changes. */
export function createSessionLease(
  guard: SessionGuard,
  ticket: SessionTicket,
  currentToken: () => string | null,
): SessionLease {
  const isCurrent = () => guard.isCurrent(ticket, currentToken());
  return {
    isCurrent,
    run: <T>(request: () => Promise<T>) => runSessionRequest(guard, ticket, request, currentToken),
    commit(effect) {
      if (!isCurrent()) return false;
      effect();
      return true;
    },
  };
}

export async function commitSessionValue<T>(
  guard: SessionGuard,
  ticket: SessionTicket,
  request: () => Promise<T>,
  currentToken: () => string | null,
  commit: (value: T) => void,
): Promise<boolean> {
  const result = await runSessionRequest(guard, ticket, request, currentToken);
  if (!result.current) return false;
  commit(result.value);
  return true;
}

export interface ClearedSessionUi {
  inbox: SessionInbox;
  syncErr: '';
}

/** Clear transient, identity-bound UI state before a different session can be restored. */
export function clearSessionUi(batchKeys: Map<unknown, unknown>): ClearedSessionUi {
  batchKeys.clear();
  return {
    inbox: emptyInbox,
    syncErr: '',
  };
}
