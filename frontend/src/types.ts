export interface Album {
  path: string;
  name: string;
  count: number;
}

export interface GallerySummary {
  total: number;
  albums: Album[];
}

export interface GalleryImage {
  id: string;
  name: string;
  album: string;
  relativePath: string;
  width: number;
  height: number;
  size: number;
  modifiedMs: number;
  thumbnailUrl: string;
  previewUrl: string;
  originalUrl: string;
}

export interface ImagesPage {
  items: GalleryImage[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface ThumbnailStatus {
  total: number;
  ready: number;
  queued: number;
  processing: number;
  failed: number;
  initialBatchReady: boolean;
  backgroundComplete: boolean;
}

export type SortMode = "name-asc" | "name-desc" | "newest";
