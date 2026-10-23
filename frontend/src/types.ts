export interface Album {
  path: string;
  name: string;
  count: number;
  cover: string | null;
  previews?: string[];
}

export type GallerySection = "library" | "albums" | "similar" | "storage" | "local" | "favorites" | "trash" | "system";

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

export interface DuplicateImage extends GalleryImage { path: string; size: number; modifiedMs: number }
export interface DuplicateGroup { id: string; images: DuplicateImage[] }
export interface DuplicateSelectionImage { id: string; size: number; modifiedMs: number }
export interface DuplicateSelectionGroup { id: string; images: DuplicateSelectionImage[] }
export interface DuplicatePage {
  groups: DuplicateGroup[]; total: number; scanned: number; imageTotal: number; skipped: number;
  scanning: boolean; revision: string; offset: number; nextOffset: number | null;
  plan: DuplicateSelectionGroup[] | null;
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

export interface NetworkHistorySample {
  at: number;
  interfaces: { name: string; receiveBytesPerSecond: number | null; sendBytesPerSecond: number | null }[] | null;
}

export interface NativeNetworkSample extends NetworkHistorySample {
  intervalSeconds: number;
}

export interface SystemInfo {
  sampledAtMs: number;
  host: {
    hostname: string | null;
    operatingSystem: string | null;
    kernel: string | null;
    architecture: string;
    cpuModel: string | null;
    logicalCpus: number | null;
  };
  cpu: { usagePercent: number | null; loadAverage: [number, number, number] | null; uptimeSeconds: number | null };
  memory: { total: number; available: number; used: number; swapTotal: number; swapUsed: number } | null;
  process: { version: string; pid: number; uptimeSeconds: number; residentMemory: number | null; threads: number | null };
  storage: { name: string; path: string; sizeBytes: number | null; state: "scanning" | "ready" | "error" }[];
  network: { name: string; receivedBytes: number; sentBytes: number; receiveBytesPerSecond: number | null; sendBytesPerSecond: number | null }[] | null;
  networkHistory: NetworkHistorySample[];
  nativeNetworkHistory: NativeNetworkSample[];
  gallery: { total: number; albums: number; initializing: boolean };
  jobs: ThumbnailStatus;
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
