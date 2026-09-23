import type { GalleryImage } from "./types";
import type { GalleryViewportAnchor } from "./galleryViewport";
import { videoFrameFromBytes, type VideoFrame } from "./videoFrame";

const STATE_KEY = "__pixhelfViewer";

export type SimilarImagePageState = {
  source: GalleryImage | null;
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
  frame?: VideoFrame;
};

// Each viewer level navigates exactly one waterfall. Its parent is the screen
// that opened that waterfall's image, including the list and return position.
export type ViewerBranch = SimilarImagePageState & {
  source: GalleryImage;
  index: number;
  parent: ViewerHistoryEntry;
};

export type ViewerHistoryEntry = {
  version: 3;
  image: GalleryImage;
  branch: ViewerBranch | null;
  depth: number;
  session: string;
  similarPage: SimilarImagePageState | null;
  returnAnchor: GalleryViewportAnchor | null;
  detached?: boolean;
};

type StoredFrame = Omit<VideoFrame, "file">;
type StoredPage = Omit<SimilarImagePageState, "frame"> & { frame?: StoredFrame };
type StoredBranch = Omit<ViewerBranch, "frame" | "parent"> & { frame?: StoredFrame; parent: StoredEntry };
type StoredEntry = Omit<ViewerHistoryEntry, "similarPage" | "branch"> & { similarPage: StoredPage | null; branch: StoredBranch | null };

function storeFrame(frame?: VideoFrame): StoredFrame | undefined {
  return frame ? { bytes: frame.bytes, time: frame.time } : undefined;
}

// File/Blob history state can become unreadable on traversal. JPEG bytes are
// portable across Back, Forward and reload; reconstruct the upload File on read.
function storeEntry(entry: ViewerHistoryEntry): StoredEntry {
  return { ...entry,
    similarPage: entry.similarPage ? { ...entry.similarPage, frame: storeFrame(entry.similarPage.frame) } : null,
    branch: entry.branch ? { ...entry.branch, frame: storeFrame(entry.branch.frame), parent: storeEntry(entry.branch.parent) } : null };
}

function restoreEntry(entry: StoredEntry): ViewerHistoryEntry {
  const frame = (value?: StoredFrame) => value ? videoFrameFromBytes(value.bytes, value.time) : undefined;
  return { ...entry,
    similarPage: entry.similarPage ? { ...entry.similarPage, frame: frame(entry.similarPage.frame) } : null,
    branch: entry.branch ? { ...entry.branch, frame: frame(entry.branch.frame), parent: restoreEntry(entry.branch.parent) } : null };
}

function isImage(value: unknown): value is GalleryImage {
  if (!value || typeof value !== "object") return false;
  const image = value as GalleryImage;
  return typeof image.id === "string" && typeof image.name === "string"
    && typeof image.width === "number" && typeof image.height === "number";
}

function isPage(page: StoredPage): boolean {
  return Array.isArray(page.images) && page.images.every(isImage)
    && (page.source === null || isImage(page.source)) && Number.isFinite(page.total)
    && (!page.frame || (page.frame.bytes instanceof Uint8Array && Number.isFinite(page.frame.time)))
    && (page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && page.nextOffset >= 0));
}

function isEntry(value: unknown, remaining = 64): value is StoredEntry {
  if (!value || typeof value !== "object" || !remaining) return false;
  const entry = value as StoredEntry;
  if (entry.version !== 3 || !isImage(entry.image) || !Number.isSafeInteger(entry.depth) || entry.depth < 1
    || typeof entry.session !== "string" || (entry.similarPage && !isPage(entry.similarPage))) return false;
  const anchor = entry.returnAnchor;
  if (anchor && (typeof anchor.imageId !== "string" || !Number.isFinite(anchor.cardRatio)
    || !Number.isFinite(anchor.viewportRatio) || !Number.isFinite(anchor.fallbackScrollY))) return false;
  const branch = entry.branch;
  return !branch || (isPage(branch) && isImage(branch.source) && Number.isSafeInteger(branch.index)
    && branch.index >= 0 && branch.images[branch.index]?.id === entry.image.id
    && isEntry(branch.parent, remaining - 1) && branch.parent.depth === entry.depth - 1);
}

export function readViewerHistoryEntry(state: unknown): ViewerHistoryEntry | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[STATE_KEY];
  if (isEntry(value)) return restoreEntry(value);
  // Entries from the released viewer still reopen their photo.
  const old = value as { version?: number; image?: GalleryImage } | undefined;
  if (old && [1, 2].includes(old.version ?? 0) && isImage(old.image)) {
    return { version: 3, image: old.image, branch: null, depth: 1, session: "legacy", similarPage: null, returnAnchor: null };
  }
  return null;
}

export function viewerHistoryState(entry: ViewerHistoryEntry): Record<string, unknown> {
  return { ...window.history.state, [STATE_KEY]: storeEntry(entry) };
}

export function galleryHistoryState(): Record<string, unknown> {
  const state = { ...window.history.state };
  delete state[STATE_KEY];
  return state;
}
