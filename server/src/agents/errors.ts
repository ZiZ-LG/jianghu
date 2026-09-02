export class AgentJobError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly scopedNotFound: boolean;

  constructor(code: string, statusCode = 409, scopedNotFound = false) {
    super(code);
    this.name = 'AgentJobError';
    this.code = code;
    this.statusCode = statusCode;
    this.scopedNotFound = scopedNotFound;
  }
}

export function agentScopedNotFound(): never {
  throw new AgentJobError('agent_resource_not_found', 404, true);
}
