import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { authentication, requireLogin } from "./auth";
import { X } from "./icons";

export const MANAGEMENT_CHANGED = "pixhelf:management-changed";
export const MAX_SELECTION = 500;
export type ManagementAction = "favorite" | "move" | "copy" | "trash" | "restore";
export type ManagementKind = "images" | "albums";
export type ManagementOptions = { destination?: string; favorite?: boolean; kind?: ManagementKind; duplicateKeepers?: Record<string, string> };
export type BatchResult = { id: string; ok: boolean; error: string | null };
export type TrashItem = { id: string; name: string; originalPath: string; deletedAt: number; size: number; fileCount: number; album?: boolean };

export async function managementRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(body === undefined ? 30_000 : 900_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`/api/management${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    signal: requestSignal,
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Pixhelf-Origin": location.origin,
      ...(authentication.csrfToken ? { "X-CSRF-Token": authentication.csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) requireLogin();
  const payload = await response.json().catch(() => { requestSignal.throwIfAborted(); return null; });
  if (!response.ok) throw new Error(payload?.error ?? "操作失败，请刷新后重试");
  return payload;
}

type ManagementContextValue = {
  favoriteIds: ReadonlySet<string>; favoriteAlbums: ReadonlySet<string>; privateAlbums: ReadonlySet<string>; trashCount: number | undefined; ready: boolean; error: string;
  busy: boolean; refresh: () => Promise<void>; notify: (message: string, error?: boolean) => void;
  progress: { completed: number; total: number } | null;
  run: (action: ManagementAction, ids: string[], options?: ManagementOptions) => Promise<BatchResult[]>;
  mutate: (path: string, body: unknown) => Promise<unknown>;
  download: (ids: string[], kind?: ManagementKind) => Promise<void>;
};
const ManagementContext = createContext<ManagementContextValue | null>(null);
export const useManagement = () => {
  const value = useContext(ManagementContext);
  if (!value) throw new Error("Missing gallery management provider");
  return value;
};

export function ManagementProvider({ children }: { children: ComponentChildren }) {
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(new Set());
  const [favoriteAlbums, setFavoriteAlbums] = useState<ReadonlySet<string>>(new Set());
  const [privateAlbums, setPrivateAlbums] = useState<ReadonlySet<string>>(new Set());
  const [trashCount, setTrashCount] = useState<number>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const running = useRef(false);
  const revision = useRef(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const notify = useCallback((message: string, error = false) => setNotice({ message, error }), []);
  const refresh = useCallback(async () => {
    if (authentication.guest) return;
    const request = ++revision.current;
    try {
      const value = await managementRequest("") as { favoriteIds?: unknown; favoriteAlbums?: unknown; privateAlbums?: unknown; trashCount?: unknown } | null;
      if (!value || !Array.isArray(value.favoriteIds) || !value.favoriteIds.every(id => typeof id === "string")
        || !Number.isSafeInteger(value.trashCount) || Number(value.trashCount) < 0) throw new Error("管理记录格式无效，请重试");
      if (request !== revision.current) return;
      const albums = value.favoriteAlbums ?? [];
      if (!Array.isArray(albums) || !albums.every(path => typeof path === "string")) throw new Error("相册收藏记录格式无效，请重试");
      const privatePaths = value.privateAlbums ?? [];
      if (!Array.isArray(privatePaths) || !privatePaths.every(path => typeof path === "string")) throw new Error("分享记录格式无效");
      setPrivateAlbums(new Set(privatePaths));
      setFavoriteAlbums(new Set(albums));
      setFavoriteIds(new Set(value.favoriteIds)); setTrashCount(Number(value.trashCount)); setReady(true); setError("");
    } catch (reason) {
      if (request === revision.current) setError(reason instanceof Error ? reason.message : "无法读取收藏和回收站");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const run = useCallback(async (action: ManagementAction, ids: string[], options: ManagementOptions = {}) => {
    if (running.current) throw new Error("请等待当前操作完成");
    running.current = true; setBusy(true);
    setProgress({ completed: 0, total: ids.length });
    try {
      const results: BatchResult[] = [];
      for (let offset = 0; offset < ids.length; offset += MAX_SELECTION) {
        const batch = ids.slice(offset, offset + MAX_SELECTION);
        const duplicateKeepers = options.duplicateKeepers && Object.fromEntries(batch.map(id => [id, options.duplicateKeepers![id]]));
        try {
          const value = await managementRequest("/batch", { action, ...options, duplicateKeepers, ids: batch }) as { results?: BatchResult[] } | null;
          if (!Array.isArray(value?.results) || value.results.length !== batch.length || !value.results.every((item, index) => item.id === batch[index] && typeof item.ok === "boolean" && (item.error === null || typeof item.error === "string"))) throw new Error("无法确认操作结果，请刷新图库查看");
          results.push(...value.results);
          setProgress({ completed: results.length, total: ids.length });
        } catch (reason) {
          const error = reason instanceof Error ? reason.message : "操作中断，请刷新查看结果";
          results.push(...ids.slice(offset).map(id => ({ id, ok: false, error })));
          break;
        }
      }
      await refresh();
      window.dispatchEvent(new CustomEvent(MANAGEMENT_CHANGED, { detail: action }));
      return results;
    } finally { running.current = false; setBusy(false); setProgress(null); }
  }, [refresh]);
  const mutate = useCallback(async (path: string, body: unknown) => {
    if (running.current || authentication.guest) throw new Error("当前无法操作，请稍后重试");
    running.current = true; setBusy(true);
    try { return await managementRequest(path, body); }
    finally {
      await refresh();
      window.dispatchEvent(new CustomEvent(MANAGEMENT_CHANGED, { detail: path }));
      running.current = false; setBusy(false);
    }
  }, [refresh]);
  const download = useCallback(async (ids: string[], kind: ManagementKind = "images") => {
    if (running.current) throw new Error("请等待当前操作完成");
    running.current = true; setBusy(true);
    try {
      const value = await managementRequest("/downloads", { ids, kind }) as { url?: string } | null;
      if (!value?.url || !/^\/api\/management\/downloads\/[a-f0-9]{64}$/.test(value.url)) throw new Error("无法准备下载，请重试");
      const link = document.createElement("a");
      link.href = value.url; link.download = "pixhelf-selection.zip";
      document.body.append(link); link.click(); link.remove();
      notify(`已开始下载 ${ids.length} 项`);
    } finally { running.current = false; setBusy(false); }
  }, [notify]);
  const value = useMemo(() => ({ favoriteIds, favoriteAlbums, privateAlbums, mutate, trashCount, ready, error, busy, progress, refresh, notify, run, download }), [favoriteIds, favoriteAlbums, privateAlbums, mutate, trashCount, ready, error, busy, progress, refresh, notify, run, download]);
  return <ManagementContext.Provider value={value}>{children}{notice && <div className="management-notice" data-error={notice.error} role={notice.error ? "alert" : "status"}>
    <span>{notice.message}</span><button type="button" aria-label="关闭操作提示" onClick={() => setNotice(null)}><X size={17} /></button>
  </div>}</ManagementContext.Provider>;
}
