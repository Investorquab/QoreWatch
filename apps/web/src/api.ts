/** Read-only calls to the QoreWatch server (same origin). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: { accept: "application/json" } });
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    body = {};
  }
  if (!r.ok) throw new ApiError((body as { error?: string }).error ?? `QoreWatch answered ${r.status}`, r.status);
  return body as T;
}

export interface Config {
  network: string;
  chainId: string;
  evmChainId: number;
  evmRpc: string;
  explorer: string;
  botUsername: string;
  attestContract: string | null;
}
