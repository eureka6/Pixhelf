import type { GallerySection } from "./types";

export interface GalleryLocation {
  section: GallerySection;
  path: string;
}

export function readGalleryLocation(): GalleryLocation {
  const params = new URLSearchParams(window.location.search);
  const section = params.get("view");
  if (section === "albums") return { section, path: params.get("album") ?? "" };
  if (section === "storage") return { section, path: params.get("path") || "/" };
  if (section === "similar") return { section, path: params.get("source") ?? "" };
  return { section: "library", path: "" };
}

export function galleryHref(section: GallerySection, path = ""): string {
  if (section === "library") return "/";
  const params = new URLSearchParams({ view: section });
  if (path && (section !== "storage" || path !== "/")) {
    params.set(section === "albums" ? "album" : section === "similar" ? "source" : "path", path);
  }
  return `/?${params}`;
}
