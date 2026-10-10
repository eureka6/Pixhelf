import { useRef, useState } from "preact/hooks";
import { authentication, requireLogin } from "./auth";
import { Check, ImageIcon, LoaderCircle, Upload, X } from "./icons";
import type { Album } from "./types";
import { useModalDialog } from "./useModalDialog";

type UploadItem = { file: File; status: "waiting" | "uploading" | "done" | "error"; progress: number; savedName?: string; error?: string };
const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = ".jpg,.jpeg,.png,.webp,.gif,.heic,.heif";

function uploadImage(file: File, destination: string, progress: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/management/upload?${new URLSearchParams({ name: file.name, destination })}`);
    request.timeout = 300_000;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-Pixhelf-Origin", location.origin);
    if (authentication.csrfToken) request.setRequestHeader("X-CSRF-Token", authentication.csrfToken);
    request.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => {
      if (request.status === 401) requireLogin();
      let payload;
      try { payload = JSON.parse(request.responseText); } catch { /* Report an unconfirmed response below. */ }
      if (request.status >= 200 && request.status < 300 && typeof payload?.path === "string") resolve(payload.path);
      else reject(new Error(payload?.error ?? (request.status === 413 ? "图片超过 50 MB 限制" : "未能确认上传结果，请刷新图库后重试")));
    };
    request.onerror = () => reject(new Error("连接中断，请检查网络后重试"));
    request.ontimeout = () => reject(new Error("上传超时，请检查图库后重试"));
    request.send(file);
  });
}

export function UploadDialog({ albums, initialDestination, onClose, onUploaded }: {
  albums: Album[]; initialDestination: string; onClose: () => void; onUploaded: () => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [destination, setDestination] = useState(initialDestination);
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useModalDialog(onClose, { dismissible: !pending,
    fallbackFocus: () => document.querySelector<HTMLButtonElement>(".gallery-menu-toggle") });
  const done = items.filter(item => item.status === "done").length;
  const waiting = items.filter(item => item.status !== "done").length;
  const add = (files: FileList | File[]) => {
    if (busy.current) return;
    const incoming = Array.from(files);
    if (incoming.some(file => !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name) || !file.size || file.size > MAX_BYTES)) {
      setError("请选择有效的 JPG、PNG、WebP、GIF 或 HEIC 图片，每张不超过 50 MB。"); return;
    }
    const unique = incoming.filter(file => !items.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified));
    if (items.length + unique.length > 100) { setError("每次最多上传 100 张图片。"); return; }
    setError("");
    setItems(current => [...current, ...unique.map(file => ({ file, status: "waiting" as const, progress: 0 }))]);
  };
  const upload = async () => {
    if (busy.current || !waiting || authentication.guest) return;
    busy.current = true; setPending(true); setError("");
    const update = (index: number, patch: Partial<UploadItem>) => setItems(current => current.map((item, i) => i === index ? { ...item, ...patch } : item));
    let uploaded = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        if (items[i].status === "done") continue;
        update(i, { status: "uploading", progress: 0, error: undefined });
        try {
          const path = await uploadImage(items[i].file, destination, progress => update(i, { progress }));
          update(i, { status: "done", progress: 100, savedName: path.split("/").pop() }); uploaded++;
        } catch (reason) { update(i, { status: "error", error: reason instanceof Error ? reason.message : "上传失败，请重试" }); }
      }
    } finally {
      busy.current = false; setPending(false);
      if (uploaded) onUploaded();
    }
  };
  return <dialog {...dialog} className="settings-dialog upload-dialog" aria-labelledby="upload-title" aria-busy={pending}>
    <header className="settings-header"><h2 id="upload-title"><Upload size={19} />上传图片</h2>
      <button type="button" className="icon-button" aria-label="关闭上传" disabled={pending} onClick={onClose} autoFocus><X size={20} /></button></header>
    <div className="upload-content">
      <label className="upload-destination">上传到<select value={destination} disabled={pending || done > 0} onChange={event => setDestination(event.currentTarget.value)}>
        <option value="">图库根目录</option>
        {initialDestination && !albums.some(album => album.path === initialDestination) && <option value={initialDestination}>{initialDestination}</option>}
        {albums.map(album => <option key={album.path} value={album.path}>{album.path}</option>)}
      </select></label>
      <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={event => { if (event.currentTarget.files) add(event.currentTarget.files); event.currentTarget.value = ""; }} />
      <button type="button" className="upload-dropzone" data-dragging={dragging} disabled={pending} onClick={() => input.current?.click()}
        onDragOver={event => { event.preventDefault(); if (!pending) setDragging(true); }}
        onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer) add(event.dataTransfer.files); }}>
        <Upload size={28} strokeWidth={1.5} /><strong>{items.length ? "继续添加图片" : "选择图片，或拖放到这里"}</strong>
        <small>JPG、PNG、WebP、GIF、HEIC · 每张最大 50 MB</small>
      </button>
      {error && <p className="upload-error" role="alert">{error}</p>}
      {items.length > 0 && <ul className="upload-list">{items.map((item, index) => <li key={`${item.file.name}-${index}`}>
        <span className="upload-file-icon"><ImageIcon size={18} /></span>
        <div className="upload-file-copy"><strong title={item.file.name}>{item.file.name}</strong>
          <small data-error={item.status === "error"}>{item.status === "error" ? item.error : item.status === "done"
            ? item.savedName && item.savedName !== item.file.name ? `已上传 · 已保存为 ${item.savedName}` : "已上传" : item.status === "uploading"
            ? item.progress === 100 ? "正在保存到图库…" : `正在上传 ${item.progress}%` : `${(item.file.size / 1024 / 1024).toFixed(1)} MB · 等待上传`}</small>
          {item.status === "uploading" && <progress max={100} value={item.progress} aria-label={`${item.file.name} 上传进度`} />}
        </div>
        {item.status === "done" ? <Check className="upload-complete" size={18} /> : <button type="button" className="icon-button" disabled={pending} aria-label={`移除 ${item.file.name}`} onClick={() => setItems(current => current.filter((_, i) => i !== index))}><X size={16} /></button>}
      </li>)}</ul>}
    </div>
    <footer className="search-dialog-footer"><p className="upload-status" role="status">{items.length ? done ? `已上传 ${done} / ${items.length} 张` : `已选择 ${items.length} 张图片` : "支持一次选择多张图片"}</p>
      {done > 0 && !waiting ? <button type="button" className="dialog-primary" onClick={onClose}>完成<Check size={17} /></button>
        : <button type="button" className="dialog-primary" disabled={pending || !waiting} onClick={() => void upload()}>{pending && <LoaderCircle className="spin" size={16} />}{pending ? "上传中…" : items.some(item => item.status === "error") ? "重试失败项" : "开始上传"}</button>}
    </footer>
  </dialog>;
}
