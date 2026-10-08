export interface Album {
  path: string;
  name: string;
  count: number;
  cover: string | null;
  previews?: string[];
}

export type GallerySection = "library" | "albums" | "similar" | "storage" | "local" | "favorites" | "trash";

export interface GallerySummary {
  total: number;
  albums: Album[];
  revision: string;
  initializing?: boolean;
}

export interface GalleryImage {
  id: string;
  name: string;
  width: number;
  height: number;
  motion?: string;
  video?: VideoMetadata;
  playback?: string;
  preview?: string;
  display?: string;
}

export interface VideoMetadata {
  duration: number | null;
  codec: string;
  audioCodec: string | null;
  frameRate: number | null;
  container: string;
}

export type ImageCardAction = "view" | "details" | "similar" | "slideshow";

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
  histogram: PhotoHistogram | null;
  video?: VideoMetadata;
}

export interface ThumbnailStatus {
  total: number;
  ready: number;
  queued: number;
  processing: number;
  failed: number;
  initialBatchReady: boolean;
  backgroundComplete: boolean;
  videos?: { playback: BackgroundJobStatus; preview: BackgroundJobStatus };
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

export interface BackgroundJobStatus {
  total: number;
  ready: number;
  queued: number;
  processing: number;
  failed: number;
  backgroundComplete: boolean;
}

export interface BootstrapData {
  summary: GallerySummary;
  status: ThumbnailStatus;
  images: ImagesPage;
}

export type SortMode = "default" | "name-asc" | "name-desc" | "newest" | "oldest" | "explore";

export interface ImageFilters {
  kind: "all" | "photo" | "live" | "video";
  orientation: "all" | "landscape" | "portrait" | "square";
  sort: SortMode;
}

export interface ContentCategory {
  name: string;
  query: string;
}
