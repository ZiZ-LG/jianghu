declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  cwd(): string;
  exitCode: number | undefined;
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
};

declare module 'node:fs/promises' {
  interface DirectoryEntry {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function mkdir(
    path: string,
    options: { readonly recursive: true },
  ): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function lstat(path: string): Promise<{
    readonly size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function readdir(
    path: string,
    options: { readonly withFileTypes: true },
  ): Promise<readonly DirectoryEntry[]>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function rm(
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ): Promise<void>;
  export function symlink(target: string, path: string): Promise<void>;
  export function stat(path: string): Promise<{ readonly mode: number }>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  export function spawnSync(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly encoding: 'utf8';
      readonly env?: Record<string, string | undefined>;
      readonly input?: Uint8Array;
    },
  ): SpawnSyncResult;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: 'sha256'): Hash;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: readonly string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: readonly string[]): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}
