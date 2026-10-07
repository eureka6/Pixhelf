import { useEffect, useRef, useState } from "preact/hooks";
import { getContentCategories } from "./api";
import { categoryError, DEFAULT_CATEGORIES, isCategoryConfig } from "./contentCategories";
import { LoaderCircle, Trash2 } from "./icons";
import { managementRequest } from "./management";
import type { ContentCategory } from "./types";

export function CategorySettings({ onPendingChange, onCategoriesSaved }: {
  onPendingChange: (pending: boolean) => void; onCategoriesSaved: (categories: ContentCategory[]) => void;
}) {
  const [categories, setCategories] = useState<ContentCategory[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void getContentCategories(controller.signal).then(value => {
      if (!controller.signal.aborted) setCategories(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取分类设置");
    });
    return () => controller.abort();
  }, [attempt]);

  const update = (next: ContentCategory[]) => { setCategories(next); setError(""); setSaved(false); };
  const save = async () => {
    if (!categories || busy.current) return;
    const next = categories.map(({ name, query }) => ({ name: name.trim(), query: query.trim() }));
    const invalid = categoryError(next);
    if (invalid) { setError(invalid); return; }
    busy.current = true; setPending(true); onPendingChange(true); setError(""); setSaved(false);
    try {
      const result = await managementRequest("/categories", { categories: next });
      if (!isCategoryConfig(result)) throw new Error("无法确认保存结果，请重试");
      setCategories(result.categories); onCategoriesSaved(result.categories); setSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存分类设置"); }
    finally { busy.current = false; setPending(false); onPendingChange(false); }
  };

  return <div className="category-settings">
    <h3 id="categories-settings-title">图片分类</h3>
    <p className="settings-description">自定义搜索面板里的分类。名称显示在按钮上，搜索描述用于查找相关图片，保存后所有设备均可使用。</p>
    {categories === null ? error
      ? <button type="button" className="settings-secondary" onClick={() => setAttempt(value => value + 1)}>重新读取</button>
      : <p className="settings-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取分类…</p>
      : <form className="category-settings-form" aria-busy={pending} onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={pending}>
          <div ref={list} className="category-settings-list">
            {categories.map((category, index) => <div className="category-settings-row" key={index}>
              <div className="settings-field"><label htmlFor={`category-name-${index}`}>分类名称</label><input id={`category-name-${index}`} value={category.name} required maxLength={24}
                placeholder="例如：旅行" onInput={event => update(categories.map((item, i) => i === index ? { ...item, name: event.currentTarget.value } : item))} /></div>
              <button type="button" className="icon-button" aria-label={`删除分类 ${category.name || index + 1}`} title="删除分类" onClick={() => update(categories.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
              <div className="settings-field category-query"><label htmlFor={`category-query-${index}`}>搜索描述</label><input id={`category-query-${index}`} value={category.query} required maxLength={200}
                placeholder="例如：海边的日落" onInput={event => update(categories.map((item, i) => i === index ? { ...item, query: event.currentTarget.value } : item))} /></div>
            </div>)}
          </div>
          {!categories.length && <p className="settings-note">暂无分类，添加后即可在搜索面板中使用。</p>}
          <div className="settings-form-actions">
            <button type="button" className="settings-secondary" disabled={categories.length >= 24} onClick={() => {
              const active = document.activeElement;
              update([...categories, { name: "", query: "" }]);
              requestAnimationFrame(() => {
                if (document.activeElement === active) list.current?.lastElementChild?.querySelector("input")?.focus();
              });
            }}>新增分类</button>
            <button type="button" className="settings-secondary" onClick={() => update(DEFAULT_CATEGORIES.map(category => ({ ...category })))}>恢复默认</button>
          </div>
          <button type="submit" className="login-submit">{pending ? "正在保存…" : "保存分类"}</button>
        </fieldset>
      </form>}
    {error && <p className="login-error" role="alert">{error}</p>}
    {saved && <p className="settings-note" role="status">分类已保存</p>}
  </div>;
}
