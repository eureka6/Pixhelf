import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChevronLeft, ChevronRight, Cloud, Download, FileIcon, Folder, Grid, ImageIcon, ListIcon, LoaderCircle, RefreshCw, Settings, X } from "./icons";
import { formatCount, formatFileSize } from "./format";
import { getStorageConfig, getStorageFiles, storageFileUrl } from "./storage";
import type { StorageConfig, StorageEntry, StoragePage } from "./storage";

export function ExternalStorageView({ path, search, revision, onOpen, onConfigure }: { path: string; search: string; revision: number; onOpen: (path: string) => void; onConfigure: () => void }) {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [page, setPage] = useState<StoragePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<StorageEntry | null>(null);
  const [mode, setMode] = useState<"grid" | "list">(() => { try { return localStorage.getItem("pixhelf.storage-view") === "grid" ? "grid" : "list"; } catch { return "list"; } });
  const controllerRef = useRef<AbortController | null>(null);
  const moreBusy = useRef(false);
  const breadcrumbsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    moreBusy.current = false; setLoadingMore(false); setLoading(true); setError(""); setPage(null); setPreview(null);
    void (async () => {
      try {
        const next = await getStorageConfig(controller.signal);
        if (controller.signal.aborted) return;
        setConfig(next);
        if (next.configured) {
          const result = await getStorageFiles(path || "/", 1, controller.signal);
          if (!controller.signal.aborted) setPage(result);
        }
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取外部存储"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [path, revision, reload]);

  const loadMore = async () => {
    if (!page?.nextPage || moreBusy.current || !controllerRef.current) return;
    const controller = controllerRef.current;
    moreBusy.current = true; setLoadingMore(true); setError("");
    try {
      const result = await getStorageFiles(path || "/", page.nextPage, controller.signal);
      if (!controller.signal.aborted) setPage(previous => ({ ...result, items: [...(previous?.items ?? []), ...result.items.filter(item => !previous?.items.some(existing => existing.path === item.path))] }));
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法加载更多文件"); }
    finally { if (!controller.signal.aborted) { moreBusy.current = false; setLoadingMore(false); } }
  };
  const items = useMemo(() => (page?.items ?? []).filter(item => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN", { numeric: true })), [page, search]);
  const parts = path.split('/').filter(Boolean);
  const filtering = Boolean(search.trim());

  useEffect(() => {
    const breadcrumbs = breadcrumbsRef.current;
    if (breadcrumbs) breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
  }, [path, config?.configured]);
  const chooseMode = (next: "grid" | "list") => { setMode(next); try { localStorage.setItem("pixhelf.storage-view", next); } catch { /* Browsing works without local storage. */ } };

  return <section className="external-storage" aria-label="外部存储" aria-busy={loading || loadingMore}>
    <header className="storage-heading">
      <div className="storage-heading-main">
        {config?.configured ? (
          <nav ref={breadcrumbsRef} className="storage-breadcrumbs" aria-label="外部存储路径">
            <h1><button type="button" aria-label="全部文件" aria-current={!parts.length ? "page" : undefined} onClick={() => onOpen("/")}>{config.name}</button></h1>
            {parts.map((part, index) => (
              <span key={`${index}:${part}`}>
                <ChevronRight size={13} />
                <button type="button" aria-current={index === parts.length - 1 ? "page" : undefined} onClick={() => onOpen(`/${parts.slice(0, index + 1).join('/')}`)}>{part}</button>
              </span>
            ))}
          </nav>
        ) : <h1>外部存储</h1>}
        {page && !loading && (
          <span className="storage-count" title={filtering ? `在已加载的 ${formatCount(page.items.length)} 项中筛选，目录共 ${formatCount(page.total)} 项` : undefined}>
            {filtering ? `${formatCount(items.length)} / ${formatCount(page.items.length)} 项` : `${formatCount(page.total)} 项`}
          </span>
        )}
      </div>
      <div className="storage-tools">
        {config?.configured && <>
          <div className="storage-view-switch" role="group" aria-label="文件显示方式">
            <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={mode === "grid"} onClick={() => chooseMode("grid")}><Grid size={16} /></button>
            <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={mode === "list"} onClick={() => chooseMode("list")}><ListIcon size={17} /></button>
          </div>
          <button type="button" className="icon-button" aria-label="刷新外部存储" title="刷新目录" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button>
        </>}
        <button type="button" className="icon-button" aria-label="外部存储设置" title="外部存储设置" onClick={onConfigure}><Settings size={16} /></button>
      </div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
    {loading ? <div className="storage-empty" role="status"><LoaderCircle className="spin" size={25} /><strong>正在读取目录…</strong></div> : config && !config.configured ? (
      <div className="storage-welcome"><Cloud size={32} strokeWidth={1.5} /><h2>连接 OpenList</h2><p>浏览、预览和下载远程文件。</p><button type="button" className="login-submit" onClick={onConfigure}>连接外部存储</button></div>
    ) : page && <>
      {items.length ? <div className={`storage-files storage-${mode}`}>
        {items.map(item => <article className="storage-entry" key={item.path} data-storage-path={item.path}>
          <button type="button" className="storage-entry-open" onClick={() => { if (item.isDir) onOpen(item.path); else setPreview(item); }} aria-label={`${item.isDir ? "打开文件夹" : "预览文件"} ${item.name}`}>
            <span className={`storage-entry-visual storage-kind-${item.kind}`}>
              {item.kind === "image" && mode === "grid" ? <StorageThumbnail entry={item} /> : item.isDir ? <Folder size={mode === "grid" ? 34 : 20} strokeWidth={1.5} /> : item.kind === "image" ? <ImageIcon size={20} /> : <FileIcon size={mode === "grid" ? 30 : 20} strokeWidth={1.5} />}
            </span>
            <strong className="storage-entry-name" title={item.name}>{item.name}</strong>
            <span className="storage-entry-size">{!item.isDir && formatFileSize(item.size)}</span>
            <time className="storage-entry-date">{formatDate(item.modified)}</time>
          </button>
          {!item.isDir && <a className="storage-entry-download" href={storageFileUrl(item.path, "download")} download={item.name} title="下载" aria-label={`下载 ${item.name}`}><Download size={16} /></a>}
        </article>)}
      </div> : <div className="storage-empty"><Folder size={32} strokeWidth={1.5} /><strong>{search.trim() ? "没有匹配的文件" : "目录为空"}</strong><span>{search.trim() ? "试试其他名称，或加载更多文件" : "添加到 OpenList 后可在这里查看"}</span></div>}
      {page.nextPage && <div className="storage-pagination"><button type="button" className="settings-secondary" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? "正在加载…" : "加载更多"}</button></div>}
    </>}
    {preview && <StoragePreview entry={preview} images={items.filter(item => item.kind === "image")} onChange={setPreview} onClose={() => setPreview(null)} />}
  </section>;
}

function StorageThumbnail({ entry }: { entry: StorageEntry }) {
  const [failed, setFailed] = useState(false);
  return failed ? <ImageIcon size={38} strokeWidth={1.5} /> : <img src={storageFileUrl(entry.path, "thumbnail")} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function StoragePreview({ entry, images, onChange, onClose }: { entry: StorageEntry; images: StorageEntry[]; onChange: (entry: StorageEntry) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const index = images.findIndex(image => image.path === entry.path);
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => setFailed(false), [entry.path]);
  return <dialog ref={ref} className="storage-preview" aria-label={`预览 ${entry.name}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }} onKeyDown={event => { if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onChange(images[index - 1]); } if (event.key === "ArrowRight" && index >= 0 && index < images.length - 1) { event.preventDefault(); onChange(images[index + 1]); } }}>
    <header><div><strong title={entry.name}>{entry.name}</strong><span>{formatFileSize(entry.size)}{entry.modified && ` · ${formatDate(entry.modified)}`}</span></div><a className="icon-button" href={storageFileUrl(entry.path, "download")} download={entry.name} aria-label="下载文件"><Download size={19} /></a><button className="icon-button" type="button" aria-label="关闭预览" onClick={onClose}><X size={21} /></button></header>
    <div className="storage-preview-stage">
      {failed ? <p role="alert">文件暂时无法预览，可尝试下载或刷新目录。</p> : entry.kind === "image" ? <img key={entry.path} src={storageFileUrl(entry.path)} alt={entry.name} onError={() => setFailed(true)} /> : entry.kind === "video" ? <video key={entry.path} controls preload="metadata" src={storageFileUrl(entry.path)} onError={() => setFailed(true)} /> : entry.kind === "audio" ? <audio key={entry.path} controls preload="metadata" src={storageFileUrl(entry.path)} onError={() => setFailed(true)} /> : <div className="storage-unsupported"><FileIcon size={48} /><p>此文件可以下载后打开</p><a href={storageFileUrl(entry.path, "download")} download={entry.name}>下载文件</a></div>}
      {index > 0 && <button type="button" className="storage-preview-previous" aria-label="上一张" onClick={() => onChange(images[index - 1])}><ChevronLeft size={24} /></button>}
      {index >= 0 && index < images.length - 1 && <button type="button" className="storage-preview-next" aria-label="下一张" onClick={() => onChange(images[index + 1])}><ChevronRight size={24} /></button>}
    </div>
  </dialog>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}
