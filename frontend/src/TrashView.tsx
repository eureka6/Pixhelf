import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatFileSize } from "./format";
import { Folder, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from "./icons";
import { MANAGEMENT_CHANGED, MAX_SELECTION, managementRequest, useManagement, type TrashItem } from "./management";

export function TrashView({ search }: { search: string }) {
  const manager = useManagement();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setError("");
    try {
      const value = await managementRequest("/trash", undefined, controller.signal) as { items?: TrashItem[] } | null;
      if (controller.signal.aborted) return;
      if (!value || !Array.isArray(value.items) || !value.items.every(item => typeof item.id === "string" && typeof item.name === "string" && typeof item.originalPath === "string" && Number.isSafeInteger(item.deletedAt))) throw new Error("回收站记录无效");
      setItems(value.items);
      const ids = new Set(value.items.map(item => item.id));
      setSelected(current => new Set([...current].filter(id => ids.has(id))));
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取回收站"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const changed = () => void load();
    window.addEventListener(MANAGEMENT_CHANGED, changed);
    return () => { requestRef.current?.abort(); window.removeEventListener(MANAGEMENT_CHANGED, changed); };
  }, [load]);
  useEffect(() => setSelected(new Set()), [search]);
  const visible = useMemo(() => items.filter(item => `${item.name} ${item.originalPath}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [items, search]);
  const restore = async (ids: string[]) => {
    try {
      const results = await manager.run("restore", ids);
      const failed = results.filter(result => !result.ok);
      manager.notify(failed.length ? `${results.length - failed.length} 项已恢复，${failed.length} 项失败：${failed[0]?.error}` : `已恢复 ${results.length} 项`, failed.length > 0);
      setSelected(new Set(failed.map(result => result.id)));
    } catch (reason) { manager.notify(reason instanceof Error ? reason.message : "恢复失败", true); }
  };
  return <section className="trash-page" aria-labelledby="trash-title">
    <header className="management-page-heading"><h1 id="trash-title"><Trash2 size={23} />回收站</h1><span>恢复后回到原相册</span></header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" aria-label="重新加载回收站" onClick={() => void load()}><RefreshCw size={17} /></button></div>}
    {loading ? <p className="trash-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取回收站…</p> : visible.length ? <>
      <div className="trash-tools"><label><input type="checkbox" aria-label="选择回收站已显示项目" disabled={manager.busy} checked={visible.slice(0, MAX_SELECTION).every(item => selected.has(item.id))} onChange={event => setSelected(new Set(event.currentTarget.checked ? visible.slice(0, MAX_SELECTION).map(item => item.id) : []))} />已选 {selected.size} 项</label>
        <button type="button" disabled={!selected.size || manager.busy} onClick={() => void restore([...selected])}><RotateCcw size={17} />{manager.busy ? "正在恢复…" : "恢复所选"}</button></div>
      <ul className="trash-list">{visible.map(item => <li key={item.id} data-selected={selected.has(item.id)}>
        <input type="checkbox" aria-label={`选择 ${item.name}`} checked={selected.has(item.id)} disabled={manager.busy} onChange={() => setSelected(current => { const next = new Set(current); if (!next.delete(item.id) && next.size < MAX_SELECTION) next.add(item.id); return next; })} />
        {item.album ? <Folder size={23} /> : <Trash2 size={23} />}<div className="trash-item-copy"><strong>{item.name}</strong><span title={item.originalPath}>{item.originalPath}</span><small>{formatFileSize(item.size)} · {new Date(item.deletedAt).toLocaleString()}{item.album ? ` · 相册，${item.fileCount} 个文件` : item.fileCount > 1 ? ` · ${item.fileCount} 个配套文件` : ""}</small></div>
        <button type="button" disabled={manager.busy} aria-label={`恢复 ${item.name}`} onClick={() => void restore([item.id])}><RotateCcw size={18} /><span>恢复</span></button>
      </li>)}</ul>
    </> : !error && <div className="empty-state"><Trash2 size={30} /><strong>{search ? "没有匹配的回收站项目" : "回收站为空"}</strong><span>移入回收站的图片、视频和相册会显示在这里</span></div>}
  </section>;
}
