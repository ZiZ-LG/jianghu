const PREFIX = /^[a-z][a-z0-9]*$/;

/** 128-bit browser CSPRNG ID; getRandomValues also works on internal HTTP origins. */
export function createOpaqueEntityId(prefix = 'id'): string {
  if (!PREFIX.test(prefix)) throw new Error('invalid entity id prefix');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
