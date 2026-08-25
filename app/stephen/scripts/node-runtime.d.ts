declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  exitCode: number | undefined;
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
};

declare module 'node:fs/promises' {
  export function mkdir(
    path: string,
    options: { readonly recursive: true },
  ): Promise<string | undefined>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}
