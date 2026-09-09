import { authentication, requireLogin } from "./auth";

export interface StorageConfig {
  configured: boolean;
  name: string;
  url: string;
  rootPath: string;
  authMode: "password" | "token";
  username: string;
  hasSecret: boolean;
  hasDirectoryPassword: boolean;
}

export interface StorageInput {
  name: string;
  url: string;
  rootPath: string;
  authMode: "password" | "token";
  username: string;
  secret: string;
  directoryPassword?: string;
}

export interface StorageEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string;
  kind: "folder" | "image" | "video" | "audio" | "file";
}

export interface StoragePage {
  items: StorageEntry[];
  path: string;
  total: number;
  page: number;
  nextPage: number | null;
}

export class StorageRequestError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    signal: signal ?? AbortSignal.timeout(40_000), redirect: "error",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Pixhelf-Origin": location.origin, ...(authentication.csrfToken ? { "X-CSRF-Token": authentication.csrfToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(reason => {
    if (signal?.aborted) throw reason;
    throw new StorageRequestError("连接超时或网络不可用，请重试", "network");
  });
  if (response.status === 401) requireLogin();
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new StorageRequestError(typeof data?.error === "string" ? data.error : "外部存储请求失败，请重试", typeof data?.code === "string" ? data.code : "request");
  if (!data || typeof data !== "object") throw new StorageRequestError("外部存储响应无效", "response");
  return data as T;
}

export const getStorageConfig = (signal?: AbortSignal) => request<StorageConfig>("/api/storage/config", undefined, signal);
export const saveStorageConfig = (input: StorageInput) => request<StorageConfig>("/api/storage/config", input);
export const testStorageConfig = (input: StorageInput) => request<{ connected: boolean }>("/api/storage/test", input);
export const disconnectStorage = () => request<void>("/api/storage/disconnect", {});
export const getStorageFiles = (path: string, page: number, signal?: AbortSignal) => request<StoragePage>(`/api/storage/list?${new URLSearchParams({ path, page: String(page) })}`, undefined, signal);
export const storageFileUrl = (path: string, mode: "preview" | "thumbnail" | "download" = "preview") => `/api/storage/file?${new URLSearchParams({ path, ...(mode === "thumbnail" ? { thumbnail: "true" } : mode === "download" ? { download: "true" } : {}) })}`;
