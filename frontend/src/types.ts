export interface Album {
  path: string;
  name: string;
  count: number;
}

export interface GallerySummary {
  total: number;
  albums: Album[];
  revision: string;
}

export interface GalleryImage {
  id: string;
  name: string;
  width: number;
  height: number;
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

export interface BootstrapData {
  summary: GallerySummary;
  status: ThumbnailStatus;
  images: ImagesPage;
}

export type SortMode = "name-asc" | "name-desc" | "newest" | "explore";
