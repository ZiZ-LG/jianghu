export class ResponseBodyByteLimitError extends Error {
  constructor() {
    super('response exceeds the byte limit');
    this.name = 'ResponseBodyByteLimitError';
  }
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('response byte limit is invalid');
  }

  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declaredBytes = Number(declaredHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      const error = new ResponseBodyByteLimitError();
      try {
        await response.body?.cancel(error);
      } catch {
        // Reject by the declared limit even if the transport cannot be cancelled.
      }
      throw error;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let aborted = signal?.aborted ?? false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel(abortError()).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (aborted) throw abortError();
    while (true) {
      const { done, value } = await reader.read();
      if (aborted) throw abortError();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (totalBytes + value.byteLength > maxBytes) {
        try {
          await reader.cancel(new ResponseBodyByteLimitError());
        } catch {
          // Preserve the deterministic byte-limit error even if transport cancel fails.
        }
        throw new ResponseBodyByteLimitError();
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
