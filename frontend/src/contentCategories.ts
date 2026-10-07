import defaults from "./defaultCategories.json";
import type { ContentCategory } from "./types";

export const DEFAULT_CATEGORIES: ContentCategory[] = defaults;

export function categoryError(categories: ContentCategory[]): string {
  if (categories.length > 24) return "最多添加 24 个分类";
  const names = new Set<string>();
  const queries = new Set<string>();
  for (const category of categories) {
    const name = category.name.trim();
    const query = category.query.trim();
    if (!name || [...name].length > 24) return "分类名称需为 1–24 个字";
    if (!query || [...query].length > 200) return "搜索描述需为 1–200 个字";
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(name + query)) return "分类不能包含控制字符";
    const nameKey = name.toLowerCase();
    const queryKey = query.toLowerCase();
    if (names.has(nameKey)) return "分类名称不能重复";
    if (queries.has(queryKey)) return "搜索描述不能重复";
    names.add(nameKey);
    queries.add(queryKey);
  }
  return "";
}

export function isCategoryConfig(value: unknown): value is { categories: ContentCategory[] } {
  if (!value || typeof value !== "object" || !("categories" in value) || !Array.isArray(value.categories)) return false;
  return value.categories.every(category => category && typeof category.name === "string" && typeof category.query === "string")
    && !categoryError(value.categories);
}

export function contentCategory(search: string, categories: ContentCategory[]): string {
  const query = search.trim().toLowerCase();
  return categories.find(category => category.query.trim().toLowerCase() === query)?.name ?? "";
}
