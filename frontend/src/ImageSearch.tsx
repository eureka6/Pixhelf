import { useEffect, useMemo } from "preact/hooks";
import { X } from "./icons";
import { formatCount } from "./format";
import type { ImageSearchSource } from "./useImageSimilarity";

export function ImageSearchSummary({ source, name, total, loading, onReplace, onClear }: {
  source: ImageSearchSource; name?: string; total: number; loading: boolean; onReplace: () => void; onClear: () => void;
}) {
  const preview = useMemo(() => source.kind === "upload" ? URL.createObjectURL(source.file)
    : `/api/images/${encodeURIComponent(source.imageId)}/thumbnail`, [source]);
  useEffect(() => () => { if (preview.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);
  return <div className="image-search-summary" role="region" aria-label="以图搜图结果">
    <img className="similar-source-preview" src={preview} alt="查询图片" />
    <div className="similar-source-copy"><strong>{source.kind === "upload" ? source.file.name : name ?? "图库图片"}</strong>
      <span role="status">{loading ? "正在查找…" : `${formatCount(total)} 张相似图片`}</span>
    </div>
    <button type="button" className="gallery-filter-reset" onClick={onReplace}>更换图片</button>
    <button type="button" className="icon-button" aria-label="清除查询图片" onClick={onClear}><X size={18} /></button>
  </div>;
}
