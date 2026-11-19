/** The fetch signature QoreWatch uses everywhere, so tests can inject their own. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** A failed HTTP read, with the status when there was one. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  fetch?: FetchLike;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts for network errors, 429 and 5xx (4xx other than 429 is never retried). */
  attempts?: number;
  /** At most this many requests in flight at once (public endpoints rate limit per IP). */
  concurrency?: number;
  userAgent?: string;
}

/**
 * A small HTTP client for public chain endpoints: timeouts, retries with backoff on
 * transient failures, a concurrency cap, and a fixed user agent (the public RPC refuses
 * some default agents).
 */
export class Http {
  private readonly f: FetchLike;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly limit: number;
  private readonly ua: string;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: HttpOptions = {}) {
    this.f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.attempts = opts.attempts ?? 4;
    this.limit = opts.concurrency ?? 6;
    this.ua = opts.userAgent ?? "QoreWatch/0.1 (+https://t.me/qorewatchbot)";
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** GET or POST JSON. Throws HttpError with the status for non-retryable answers. */
  async json<T = unknown>(url: string, body?: unknown): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt) await sleep(Math.min(8000, 400 * 2 ** attempt));
      try {
        return await this.slot(async () => {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
          try {
            const res = await this.f(url, {
              method: body === undefined ? "GET" : "POST",
              headers: { "user-agent": this.ua, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              signal: ctl.signal,
            });
            if (!res.ok) {
              const retryable = res.status === 429 || res.status >= 500;
              const err = new HttpError(`HTTP ${res.status} from ${redact(url)}`, url, res.status);
              if (!retryable) throw Object.assign(err, { final: true });
              throw err;
            }
            return (await res.json()) as T;
          } finally {
            clearTimeout(timer);
          }
        });
      } catch (e) {
        last = e;
        if ((e as { final?: boolean }).final) throw e;
      }
    }
    if (last instanceof HttpError) throw last;
    throw new HttpError(`Could not reach ${redact(url)}: ${(last as Error)?.message ?? last}`, url);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip query strings from URLs in messages (they can carry addresses of users). */
function redact(url: string): string {
  return url.split("?")[0]!;
}
