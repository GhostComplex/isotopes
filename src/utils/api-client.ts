const DEFAULT_PORT = 2712;

export function getApiPort(): number {
  return process.env.ISOTOPES_PORT ? parseInt(process.env.ISOTOPES_PORT, 10) : DEFAULT_PORT;
}

function getBaseUrl(): string {
  return `http://127.0.0.1:${getApiPort()}`;
}

export class ApiError extends Error {
  constructor(public status: number) {
    super(`API error: ${status}`);
  }
}

export async function apiFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${getBaseUrl()}${path}`, init);
  if (!res.ok) throw new ApiError(res.status);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function apiStream(path: string, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${getBaseUrl()}${path}`, { signal });
  if (!res.ok) throw new ApiError(res.status);
  return res.body!.getReader();
}
