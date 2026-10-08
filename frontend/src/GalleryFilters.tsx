import { contentCategory } from "./contentCategories";
import type { ContentCategory, ImageFilters } from "./types";

export const DEFAULT_IMAGE_FILTERS: ImageFilters = { kind: "all", orientation: "all", sort: "default" };
const KINDS = [["all", "全部类型"], ["photo", "普通图片"], ["live", "实况与动图"], ["video", "视频"]] as const;
const ORIENTATIONS = [["all", "全部画幅"], ["landscape", "横图"], ["portrait", "竖图"], ["square", "方图"]] as const;
const SORTS = [["default", "默认排序"], ["name-asc", "文件名 A → Z"], ["name-desc", "文件名 Z → A"], ["newest", "最近修改"], ["oldest", "最早修改"], ["explore", "随机浏览"]] as const;
export function imageFilterLabels(filters: ImageFilters, search = "", categories: ContentCategory[] = []): string[] {
  return [contentCategory(search, categories), filters.kind !== "all" && KINDS.find(([value]) => value === filters.kind)?.[1],
    filters.orientation !== "all" && ORIENTATIONS.find(([value]) => value === filters.orientation)?.[1],
    filters.sort !== "default" && SORTS.find(([value]) => value === filters.sort)?.[1]].filter((label): label is string => Boolean(label));
}

export function GalleryFilters({ filters, search, categories, categoriesHint, onConfigureCategories, onChange, onContentChange, contentReady, contentHint }: {
  filters: ImageFilters; search: string; categories: ContentCategory[]; categoriesHint: string; onConfigureCategories?: () => void;
  onChange: (filters: ImageFilters) => void; onContentChange: (query: string) => void;
  contentReady: boolean; contentHint: string;
}) {
  const category = contentReady ? contentCategory(search, categories) : "";
  return <div className="gallery-filter-controls">
    <fieldset className="gallery-filter-content"><legend><span>内容分类</span>
      {onConfigureCategories && <button type="button" className="gallery-filter-reset" onClick={onConfigureCategories}>管理分类</button>}
    </legend>
      <div className="gallery-filter-options">
        <button type="button" aria-pressed={!category} onClick={() => onContentChange("")}>全部</button>
        {categories.map(({ query, name }) => <button key={query} type="button" disabled={!contentReady} aria-pressed={category === name}
          onClick={() => onContentChange(category === name ? "" : query)}>{name}</button>)}
      </div>
      {(categoriesHint || !contentReady) && <p>{categoriesHint || contentHint}</p>}
    </fieldset>
    <div className="gallery-filter-fields">
      <label>媒体类型<select aria-label="媒体类型" value={filters.kind} onChange={event => onChange({ ...filters, kind: event.currentTarget.value as ImageFilters["kind"] })}>
        {KINDS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <label>图片画幅<select aria-label="图片画幅" value={filters.orientation} onChange={event => onChange({ ...filters, orientation: event.currentTarget.value as ImageFilters["orientation"] })}>
        {ORIENTATIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <label className="gallery-filter-sort">排序<select aria-label="排序方式" value={filters.sort} onChange={event => onChange({ ...filters, sort: event.currentTarget.value as ImageFilters["sort"] })}>
        {SORTS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      {filters.sort === "explore" && <p className="gallery-filter-hint">随机排列当前筛选结果。</p>}
    </div>
  </div>;
}
