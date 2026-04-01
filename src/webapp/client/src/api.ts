const BASE = '/api';

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  if (res.status === 401) throw new ApiError('Unauthenticated', 401);

  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);

  return data as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export { ApiError };
