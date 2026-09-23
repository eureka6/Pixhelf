import { useState } from "preact/hooks";
import { X } from "./icons";
import { useManagement } from "./management";
import { SelectionDialog } from "./SelectableGallery";
import { useModalDialog } from "./useModalDialog";

export type DirectoryAction = "create" | "rename" | "move" | "trash";
export function DirectoryActionDialog({ action, path, onClose, onDone }: { action: DirectoryAction; path: string; onClose: () => void; onDone: (path: string) => void }) {
  const manager = useManagement();
  const [name, setName] = useState(action === "rename" ? path.split("/").at(-1) ?? "" : "");
  const [error, setError] = useState("");
  const perform = async (destination?: string) => {
    setError("");
    try {
      const result = await manager.mutate("/directories", { action, path, ...(action === "move" ? { destination } : action === "trash" ? {} : { name: name.trim() }) }) as { path: string };
      manager.notify(action === "trash" ? "已移入回收站" : action === "create" ? "目录已创建" : action === "rename" ? "目录已重命名" : "目录已移动");
      onDone(result.path);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "目录操作失败"); }
  };
  if (action === "move" || action === "trash") return <SelectionDialog kind={action} selectedAlbums={[{ path, name: path.split("/").at(-1) ?? path, count: 0, cover: null }]} busy={manager.busy} error={error} onClose={onClose} onConfirm={destination => void perform(destination)} />;
  return <DirectoryNameDialog name={name} onName={setName} action={action} path={path} error={error} busy={manager.busy} onClose={onClose} onSubmit={() => void perform()} />;
}

function DirectoryNameDialog({ name, onName, action, path, error, busy, onClose, onSubmit }: {
  name: string; onName: (name: string) => void; action: "create" | "rename"; path: string; error: string; busy: boolean; onClose: () => void; onSubmit: () => void;
}) {
  const dialog = useModalDialog(onClose, { dismissible: !busy });
  return <dialog {...dialog} className="selection-dialog" aria-labelledby="directory-name-title">
    <form onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) onSubmit(); }}>
      <header><h2 id="directory-name-title">{action === "create" ? "新建目录" : "重命名"}</h2><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={20} /></button></header>
      <p className="directory-dialog-path" title={path || "图库根目录"}>{path || "图库根目录"}</p>
      <input className="directory-name-input" aria-label="目录名称" placeholder="目录名称" autoFocus value={name} maxLength={255} disabled={busy} onInput={event => onName(event.currentTarget.value)} onFocus={event => event.currentTarget.select()} />
      {error && <p className="directory-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="selection-confirm" disabled={busy || !name.trim() || (action === "rename" && name.trim() === path.split("/").at(-1))}>{busy ? "处理中…" : "保存"}</button></footer>
    </form>
  </dialog>;
}
