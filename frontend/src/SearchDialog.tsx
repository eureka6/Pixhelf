import { useRef, useState } from "preact/hooks";
import { GalleryFilters, SearchCategories, imageFilterLabels } from "./GalleryFilters";
import { ArrowRight, ImageIcon, Search, X } from "./icons";
import type { ContentCategory, ImageFilters } from "./types";
import { useModalDialog } from "./useModalDialog";
import type { useSearchHistory } from "./useSearchHistory";

export type SearchDialogProps = {
  search: string;
  searchMode: "filename" | "indexing" | "semantic";
  albumSearch: boolean;
  storageSearch: boolean;
  localSearch?: boolean;
  similarSearch: boolean;
  duplicateSearch?: boolean;
  onSearchChange: (value: string) => void;
  onImageSearch: (file: File) => void;
  filters: ImageFilters | null;
  onFiltersChange: (filters: ImageFilters) => void;
  onContentChange: (query: string) => void;
  onResetFilters: () => void;
  categories: ContentCategory[];
  categoriesHint: string;
};

export function SearchDialog({ onClose, history, ...props }: SearchDialogProps & { onClose: () => void; history: ReturnType<typeof useSearchHistory> }) {
  const { search, searchMode, albumSearch, storageSearch, localSearch, similarSearch, duplicateSearch, filters, categories,
    categoriesHint, onSearchChange, onImageSearch, onFiltersChange, onContentChange, onResetFilters } = props;
  const input = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState("");
  const chooseImage = (file: File | undefined) => {
    if (!file) return;
    if (!file.size) { setImageError("图片文件为空，请重新选择"); return; }
    if (file.size > 20 * 1024 * 1024) { setImageError("图片不能超过 20 MB"); return; }
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name) && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setImageError("请选择 JPG、PNG、WebP 或 GIF 图片"); return;
    }
    setImageError("");
    onImageSearch(file);
    onClose();
  };
  const focusSearch = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const semantic = !albumSearch && !storageSearch && !localSearch && !similarSearch && !duplicateSearch && searchMode === "semantic";
  const placeholder = duplicateSearch ? "搜索重复图片名称或路径" : localSearch ? "搜索当前目录" : similarSearch ? "筛选已加载结果" : storageSearch ? "筛选已加载文件"
    : albumSearch ? "搜索相册名称或路径" : semantic ? "搜索图片" : "搜索文件名";
  const labels = filters ? imageFilterLabels(filters, semantic ? search : "", categories) : [];
  const dialog = useModalDialog(onClose, { fallbackFocus: () => document.querySelector<HTMLButtonElement>(".search-toggle") });
  return <dialog {...dialog} id="gallery-search-dialog" className="settings-dialog search-dialog" data-dragging={dragging} aria-label={albumSearch ? "搜索相册" : "搜索图库"}>
    <form className="search-dialog-form" onSubmit={event => { event.preventDefault(); history.remember(search); onClose(); }}
      onDragEnter={event => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={event => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false);
      }}
      onDrop={event => {
        setDragging(false);
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        chooseImage(event.dataTransfer.files[0]);
      }}>
      <header className="search-dialog-header">
        {filters ? <GalleryFilters filters={filters} onChange={onFiltersChange} /> : <span className="search-dialog-title">{albumSearch ? "搜索相册" : "搜索"}</span>}
        <button type="button" className="icon-button" aria-label="关闭搜索" onClick={onClose} autoFocus={!focusSearch}><X size={20} /></button>
      </header>
      <div className="search-dialog-content">
        {filters && <SearchCategories search={search} categories={categories} categoriesHint={categoriesHint}
          onContentChange={onContentChange} contentReady={semantic}
          contentHint={searchMode === "indexing" ? "分类准备中，完成后即可使用。" : "在开启自然语言搜索的图库或相册中可用。"} />}
        <div className="search-input-row">
          <div className="gallery-search-input" title="可将图片拖入搜索窗口，以图搜图">
            <Search size={20} />
            <input ref={input} type="search" value={search} placeholder={placeholder} aria-label={albumSearch ? "搜索相册" : semantic ? "用自然语言搜索图片" : placeholder}
              onInput={event => onSearchChange(event.currentTarget.value)} enterKeyHint="search" autoComplete="off" autoFocus={focusSearch}
              onKeyDown={event => {
                if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault();
                if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); onClose(); }
              }} />
            {search && <button type="button" className="clear-search" aria-label="清空搜索" onClick={() => { onSearchChange(""); input.current?.focus(); }}><X size={17} /></button>}
          </div>
          {imageError && <p className="search-image-error" role="alert">{imageError}</p>}
        </div>
        <section className="search-history" aria-labelledby="search-history-title">
          <div className="search-history-heading"><h3 id="search-history-title">搜索历史</h3>
            <button type="button" className="gallery-filter-reset" aria-label="清空搜索历史" disabled={!history.entries.length} onClick={history.clear}>清空</button>
          </div>
          {history.entries.length ? <div className="search-history-items">
            {history.entries.map(query => <button key={query} type="button" title={query} onClick={() => { onSearchChange(query); history.remember(query); onClose(); }}>{query}</button>)}
          </div> : <p className="search-history-empty">暂无搜索历史</p>}
        </section>
      </div>
      <footer className="search-dialog-footer">
        <button type="button" className="gallery-filter-reset" disabled={!search && !labels.length} onClick={onResetFilters}>重置条件</button>
        <div className="search-submit-actions">
          <input ref={imageInput} type="file" hidden accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif" aria-label="上传查询图片"
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; chooseImage(file); }} />
          <button type="button" className="search-image-picker" title="选择图片或拖入搜索窗口 · JPG、PNG、WebP、GIF，最大 20 MB"
            onClick={() => imageInput.current?.click()}><ImageIcon size={18} /><span>以图搜图</span></button>
          <button type="submit" className="dialog-primary">搜索<ArrowRight size={17} /></button>
        </div>
      </footer>
      {dragging && <div className="search-image-drop-hint" aria-hidden="true">
        <ImageIcon size={30} strokeWidth={1.6} /><strong>松开图片，以图搜图</strong>
        <span>JPG、PNG、WebP、GIF · 最大 20 MB</span>
      </div>}
    </form>
  </dialog>;
}
