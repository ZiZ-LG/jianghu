export class CapabilityDeniedError extends Error {
  readonly statusCode = 403;
  readonly code = 'capability_denied';

  constructor() {
    super('能力未启用');
    this.name = 'CapabilityDeniedError';
  }
}
