import { useRef } from "preact/hooks";
import { GalleryFilters, imageFilterLabels } from "./GalleryFilters";
import { ArrowRight, Search, X } from "./icons";
import type { ContentCategory, ImageFilters } from "./types";
import { useModalDialog } from "./useModalDialog";

export type SearchDialogProps = {
  search: string;
  searchMode: "filename" | "indexing" | "semantic";
  albumSearch: boolean;
  storageSearch: boolean;
  localSearch?: boolean;
  similarSearch: boolean;
  onSearchChange: (value: string) => void;
  filters: ImageFilters | null;
  onFiltersChange: (filters: ImageFilters) => void;
  onContentChange: (query: string) => void;
  onResetFilters: () => void;
  categories: ContentCategory[];
  categoriesHint: string;
  onConfigureCategories?: () => void;
};

export function SearchDialog({ onClose, ...props }: SearchDialogProps & { onClose: () => void }) {
  const { search, searchMode, albumSearch, storageSearch, localSearch, similarSearch, filters, categories,
    categoriesHint, onSearchChange, onFiltersChange, onContentChange, onResetFilters, onConfigureCategories } = props;
  const input = useRef<HTMLInputElement>(null);
  const focusSearch = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const semantic = !albumSearch && !storageSearch && !localSearch && !similarSearch && searchMode === "semantic";
  const placeholder = localSearch ? "搜索当前目录" : similarSearch ? "筛选已加载结果" : storageSearch ? "筛选已加载文件"
    : albumSearch ? "搜索相册名称或路径" : semantic ? "搜索图片" : "搜索文件名";
  const labels = filters ? imageFilterLabels(filters, semantic ? search : "", categories) : [];
  const dialog = useModalDialog(onClose, { fallbackFocus: () => document.querySelector<HTMLButtonElement>(".search-toggle") });
  return <dialog {...dialog} id="gallery-search-dialog" className="settings-dialog search-dialog" aria-label={albumSearch ? "搜索相册" : "搜索图库"}>
    <form className="search-dialog-form" onSubmit={event => { event.preventDefault(); onClose(); }}>
      <header className="search-dialog-header">
        <div className="gallery-search-input">
          <Search size={20} />
          <input ref={input} type="search" value={search} placeholder={placeholder} aria-label={albumSearch ? "搜索相册" : semantic ? "用自然语言搜索图片" : placeholder}
            onInput={event => onSearchChange(event.currentTarget.value)} enterKeyHint="search" autoComplete="off" autoFocus={focusSearch}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault();
              if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); onClose(); }
            }} />
          {search && <button type="button" className="clear-search" aria-label="清空搜索" onClick={() => { onSearchChange(""); input.current?.focus(); }}><X size={17} /></button>}
        </div>
        <button type="button" className="icon-button" aria-label="关闭搜索" onClick={onClose} autoFocus={!focusSearch}><X size={20} /></button>
      </header>
      {filters && <div className="search-dialog-content">
        <GalleryFilters filters={filters} search={search} categories={categories} categoriesHint={categoriesHint}
          onChange={onFiltersChange} onContentChange={onContentChange} contentReady={semantic}
          contentHint={searchMode === "indexing" ? "内容分类准备中，完成后即可使用。" : "在开启自然语言搜索的图库或相册中可用。"}
          onConfigureCategories={onConfigureCategories && (() => { onClose(); onConfigureCategories(); })} />
      </div>}
      <footer className="search-dialog-footer">
        <button type="button" className="gallery-filter-reset" disabled={!search && !labels.length} onClick={onResetFilters}>重置条件</button>
        <button type="submit" className="dialog-primary">搜索<ArrowRight size={17} /></button>
      </footer>
    </form>
  </dialog>;
}
