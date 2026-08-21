export interface BatchFailure<T> { item: T; error: string }
export interface BatchProgress<T> {
  total: number;
  processed: number;
  successes: T[];
  failures: Array<BatchFailure<T>>;
}

export interface BatchRunOptions {
  isCancelled?: () => boolean;
  cancellationError?: () => Error;
}

type BatchLogicalItem = { kind: string; id: string };
export type StableBatchKeyCache = Map<string, { signature: string; key: string }>;

const logicalItemKey = (item: BatchLogicalItem): string => `${item.kind}:${item.id}`;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function stableBatchItemKey<T extends BatchLogicalItem>(
  cache: StableBatchKeyCache,
  item: T,
  createKey: () => string,
): string {
  const identity = logicalItemKey(item);
  const signature = JSON.stringify(canonicalValue(item));
  const current = cache.get(identity);
  if (current?.signature === signature) return current.key;
  const key = createKey();
  cache.set(identity, { signature, key });
  return key;
}

export function clearStableBatchItemKey(
  cache: StableBatchKeyCache,
  item: BatchLogicalItem,
): void {
  cache.delete(logicalItemKey(item));
}

export async function runBatchWithProgress<T>(
  items: readonly T[],
  process: (item: T) => Promise<void>,
  onProgress: (progress: BatchProgress<T>) => void = () => undefined,
  options: BatchRunOptions = {},
): Promise<BatchProgress<T>> {
  const progress: BatchProgress<T> = {
    total: items.length,
    processed: 0,
    successes: [],
    failures: [],
  };
  const publish = () => onProgress({
    ...progress,
    successes: [...progress.successes],
    failures: [...progress.failures],
  });
  const abortIfCancelled = () => {
    if (!options.isCancelled?.()) return;
    throw options.cancellationError?.() ?? new Error('批处理已取消');
  };
  abortIfCancelled();
  publish();
  for (const item of items) {
    abortIfCancelled();
    try {
      await process(item);
      abortIfCancelled();
      progress.successes.push(item);
    } catch (cause) {
      abortIfCancelled();
      progress.failures.push({
        item,
        error: cause instanceof Error ? cause.message : String(cause || '未知错误'),
      });
    }
    progress.processed += 1;
    publish();
  }
  return progress;
}

export function removeSuccessfulSelections<T extends { kind: string; id: string }>(
  selected: ReadonlySet<string>,
  successes: readonly T[],
): Set<string> {
  const succeeded = new Set(successes.map((item) => `${item.kind}:${item.id}`));
  return new Set([...selected].filter((key) => !succeeded.has(key)));
}
