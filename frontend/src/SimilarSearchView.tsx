import type { RefObject } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { GallerySkeleton, JustifiedGallery } from "./JustifiedGallery";
import type { JustifiedGalleryHandle } from "./JustifiedGallery";
import { ImageIcon, LoaderCircle, RefreshCw, ScanSearch, X } from "./icons";
import { formatCount } from "./format";
import type { ImageCardAction } from "./types";
import type { ImageSearchSource, useImageSimilarity } from "./useImageSimilarity";

export function SimilarSearchView({ source, results, filter, onUpload, onClear, onOpen, layoutRef, preserveViewport }: {
  source: ImageSearchSource | null; results: ReturnType<typeof useImageSimilarity>; filter: string;
  onUpload: (file: File) => void; onClear: () => void;
  onOpen: (id: string, card: HTMLElement, pointerY?: number, action?: ImageCardAction) => void;
  layoutRef: RefObject<JustifiedGalleryHandle>; preserveViewport: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState("");
  const preview = useMemo(() => source?.kind === "upload" ? URL.createObjectURL(source.file)
    : source ? `/api/images/${encodeURIComponent(source.imageId)}/thumbnail` : "", [source]);
  useEffect(() => () => { if (preview.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);
  const images = useMemo(() => {
    const value = filter.trim().toLocaleLowerCase();
    return value ? results.images.filter(image => image.name.toLocaleLowerCase().includes(value)) : results.images;
  }, [results.images, filter]);
  useEffect(() => {
    if (!source || results.loading || results.loadingMore || results.error || results.nextOffset === null || !sentinelRef.current) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) void results.loadMore(); }, { rootMargin: "900px 0px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [source, results.loading, results.loadingMore, results.error, results.nextOffset, results.loadMore]);
  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!file.size) { setFileError("图片文件为空，请重新选择"); return; }
    if (file.size > 20 * 1024 * 1024) { setFileError("图片不能超过 20 MB"); return; }
    if (!/\.(jpe?g|png|webp)$/i.test(file.name) && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setFileError("请选择 JPG、PNG 或 WebP 图片"); return;
    }
    setFileError("");
    onUpload(file);
  };
  return (
    <section className="similar-search-page" aria-labelledby="similar-search-title">
      <header className="similar-search-heading"><h1 id="similar-search-title"><ScanSearch size={22} />相似图片</h1><span>以图搜图</span></header>
      <input ref={inputRef} type="file" hidden accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" aria-label="上传查询图片"
        onChange={event => { choose(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
      <div className={`similar-upload ${source ? "has-source" : ""}`} data-dragging={dragging}
        onDragOver={event => { event.preventDefault(); setDragging(true); }}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); }}
        onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer?.files[0]); }}>
        {source ? <>
          <img className="similar-source-preview" src={preview} alt="查询图片" />
          <div className="similar-source-copy"><span>查询图片</span><strong>{source.kind === "upload" ? source.file.name : results.reference?.name ?? "图库图片"}</strong><span>{results.loading ? "正在查找…" : `${formatCount(results.total)} 张相似图片`}</span></div>
          <div className="similar-source-actions"><button type="button" onClick={() => inputRef.current?.click()}>更换图片</button><button type="button" className="similar-clear" aria-label="清除查询图片" onClick={() => { setFileError(""); onClear(); }}><X size={18} /></button></div>
        </> : <>
          <ImageIcon size={34} strokeWidth={1.5} /><strong>上传图片，查找图库中的相似图片</strong>
          <span>选择或拖入 JPG、PNG、WebP 图片，最大 20 MB</span>
          <button type="button" onClick={() => inputRef.current?.click()}>选择图片</button>
        </>}
      </div>
      {fileError && <p className="similar-search-error" role="alert">{fileError}</p>}
      {results.error && <div className="similar-search-error" role="alert"><span>{results.error}</span><button type="button" onClick={results.retry}><RefreshCw size={15} />重试</button></div>}
      {source && (results.loading ? <GallerySkeleton /> : images.length ?
        <JustifiedGallery ref={layoutRef} images={images} preserveViewport={preserveViewport} onOpen={onOpen} />
        : !results.error && <div className="similar-search-empty"><ScanSearch size={28} /><strong>{filter ? "没有匹配的结果" : "没有找到相似图片"}</strong><span>{filter ? "试试其他文件名" : "换一张图片试试"}</span></div>)}
      {source && <div ref={sentinelRef} className="load-sentinel similar-results-footer" aria-live="polite">
        {results.loadingMore ? <><LoaderCircle className="spin" size={18} />正在加载更多</> : results.nextOffset !== null ?
          <button type="button" onClick={() => void results.loadMore()}>加载更多</button>
          : !results.loading && images.length > 0 && <span>已显示 {formatCount(images.length)} 张{filter ? "匹配图片" : "相似图片"}</span>}
      </div>}
    </section>
  );
}
