import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { API_URL } from "../config";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const REFRESH_KEY = "lp.refreshToken";
let accessToken: string | undefined;
let refreshToken: string | undefined;
let onSignedOut: (() => void) | undefined;

const secure = {
  async get(k: string) {
    if (Platform.OS === "web") return undefined;
    return (await SecureStore.getItemAsync(k)) ?? undefined;
  },
  async set(k: string, v: string) {
    if (Platform.OS !== "web") await SecureStore.setItemAsync(k, v);
  },
  async del(k: string) {
    if (Platform.OS !== "web") await SecureStore.deleteItemAsync(k);
  },
};

export const session = {
  async restore(): Promise<boolean> {
    refreshToken = await secure.get(REFRESH_KEY);
    if (!refreshToken) return false;
    return refresh();
  },
  async set(tokens: { accessToken: string; refreshToken: string }) {
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    await secure.set(REFRESH_KEY, tokens.refreshToken);
  },
  async clear() {
    const rt = refreshToken;
    accessToken = undefined;
    refreshToken = undefined;
    await secure.del(REFRESH_KEY);
    if (rt) await raw("POST", "/v1/auth/logout", { refreshToken: rt }).catch(() => undefined);
  },
  onSignedOut(cb: () => void) {
    onSignedOut = cb;
  },
};

async function raw(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (json as { error?: { code: string; message: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json;
}

let refreshing: Promise<boolean> | undefined;
async function refresh(): Promise<boolean> {
  if (!refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const r = (await raw("POST", "/v1/auth/refresh", { refreshToken })) as { accessToken: string; refreshToken: string };
      await session.set(r);
      return true;
    } catch {
      accessToken = undefined;
      refreshToken = undefined;
      await secure.del(REFRESH_KEY);
      return false;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return (await raw(method, path, body, accessToken)) as T;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refresh())) return (await raw(method, path, body, accessToken)) as T;
    if (e instanceof ApiError && e.status === 401) onSignedOut?.();
    throw e;
  }
}

/** Unauthenticated calls used during sign-in. */
export const publicApi = { post: <T>(path: string, body: unknown) => raw("POST", path, body) as Promise<T> };

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details) ? (e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join("\n") : "";
    return details ? `${e.message}\n${details}` : e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}
