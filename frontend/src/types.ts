export interface Album {
  path: string;
  name: string;
  count: number;
  cover: string | null;
}

export type GallerySection = "library" | "albums" | "similar" | "storage";

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

export type ImageCardAction = "view" | "details" | "similar";

export interface ImagesPage {
  items: GalleryImage[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface PhotoExifField {
  label: string;
  value: string;
}

export interface PhotoHistogram {
  red: number[];
  green: number[];
  blue: number[];
  luminance: number[];
}

export interface PhotoDetails {
  fileSize: number;
  modifiedMs: number;
  exif: PhotoExifField[];
  histogram: PhotoHistogram;
}

export interface ThumbnailStatus {
  total: number;
  ready: number;
  queued: number;
  processing: number;
  failed: number;
  initialBatchReady: boolean;
  backgroundComplete: boolean;
  textSearch: {
    enabled: boolean;
    total: number;
    ready: number;
    queued: number;
    processing: number;
    failed: number;
    backgroundComplete: boolean;
  };
}

export interface BootstrapData {
  summary: GallerySummary;
  status: ThumbnailStatus;
  images: ImagesPage;
}

export type SortMode = "name-asc" | "name-desc" | "newest" | "explore";
