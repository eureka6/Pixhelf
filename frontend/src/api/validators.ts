import type { Album, BootstrapData, DuplicatePage, GalleryImage, GallerySummary, ImagesPage,
  PhotoDetails, ThumbnailStatus, VideoMetadata } from "../types";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isAlbum(value: unknown): value is Album {
  return isObject(value)
    && typeof value.path === "string"
    && typeof value.name === "string"
    && isNonNegativeInteger(value.count)
    && (value.cover === null || typeof value.cover === "string")
    && (value.previews === undefined || (Array.isArray(value.previews)
      && value.previews.length <= 3 && value.previews.every(id => typeof id === "string")));
}

export function isGalleryImage(value: unknown): value is GalleryImage {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && (value.motion === undefined || typeof value.motion === "string")
    && (value.video === undefined || isVideoMetadata(value.video))
    && (value.playback === undefined || typeof value.playback === "string")
    && (value.preview === undefined || typeof value.preview === "string")
    && (value.display === undefined || typeof value.display === "string")
    && isPositiveInteger(value.width)
    && isPositiveInteger(value.height);
}

function isVideoMetadata(value: unknown): value is VideoMetadata {
  const positiveOrNull = (number: unknown) => number === null
    || (typeof number === "number" && Number.isFinite(number) && number > 0);
  return isObject(value) && positiveOrNull(value.duration) && positiveOrNull(value.frameRate)
    && typeof value.codec === "string" && typeof value.container === "string"
    && (value.audioCodec === null || typeof value.audioCodec === "string");
}

export function isGallerySummary(value: unknown): value is GallerySummary {
  return isObject(value)
    && isNonNegativeInteger(value.total)
    && Array.isArray(value.albums)
    && value.albums.every(isAlbum)
    && typeof value.revision === "string"
    && (value.initializing === undefined || typeof value.initializing === "boolean");
}

export function isImagesPage(value: unknown): value is ImagesPage {
  return isObject(value)
    && Array.isArray(value.items)
    && value.items.every(isGalleryImage)
    && isNonNegativeInteger(value.total)
    && isNonNegativeInteger(value.offset)
    && isPositiveInteger(value.limit)
    && (value.nextOffset === null || (isNonNegativeInteger(value.nextOffset)
      && value.nextOffset > value.offset && value.nextOffset < value.total));
}

function isHistogramChannel(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 256
    && value.every(isNonNegativeInteger);
}

export function isPhotoDetails(value: unknown): value is PhotoDetails {
  return isObject(value)
    && isNonNegativeInteger(value.fileSize)
    && isNonNegativeInteger(value.modifiedMs)
    && Array.isArray(value.exif)
    && value.exif.every((field) => isObject(field)
      && typeof field.label === "string"
      && typeof field.value === "string")
    && (value.video === undefined || isVideoMetadata(value.video))
    && ((value.histogram === null && isVideoMetadata(value.video)) || (isObject(value.histogram)
    && isHistogramChannel(value.histogram.red)
    && isHistogramChannel(value.histogram.green)
    && isHistogramChannel(value.histogram.blue)
    && isHistogramChannel(value.histogram.luminance)));
}

export function isThumbnailStatus(value: unknown): value is ThumbnailStatus {
  return isObject(value)
    && isNonNegativeInteger(value.total)
    && isNonNegativeInteger(value.ready)
    && isNonNegativeInteger(value.queued)
    && isNonNegativeInteger(value.processing)
    && isNonNegativeInteger(value.failed)
    && typeof value.initialBatchReady === "boolean"
    && typeof value.backgroundComplete === "boolean"
    && (value.videos === undefined || (isObject(value.videos)
      && isBackgroundJobStatus(value.videos.playback) && isBackgroundJobStatus(value.videos.preview)))
    && isObject(value.textSearch)
    && typeof value.textSearch.enabled === "boolean"
    && isBackgroundJobStatus(value.textSearch);
}

function isBackgroundJobStatus(value: unknown): boolean {
  return isObject(value) && [value.total, value.ready, value.queued, value.processing, value.failed].every(isNonNegativeInteger)
    && typeof value.backgroundComplete === "boolean";
}

export function isBootstrapData(value: unknown): value is BootstrapData {
  return isObject(value)
    && isGallerySummary(value.summary)
    && isThumbnailStatus(value.status)
    && isImagesPage(value.images);
}

export function isDuplicatePage(value: unknown): value is DuplicatePage {
  return isObject(value)
    && Array.isArray(value.groups) && value.groups.every(group => isObject(group) && typeof group.id === "string"
      && Array.isArray(group.images) && group.images.length >= 2 && group.images.every(image => isGalleryImage(image)
        && isObject(image) && typeof image.path === "string" && isNonNegativeInteger(image.size) && isNonNegativeInteger(image.modifiedMs)))
    && [value.total, value.scanned, value.imageTotal, value.skipped, value.offset].every(isNonNegativeInteger)
    && typeof value.scanning === "boolean" && typeof value.revision === "string"
    && (value.plan === null || Array.isArray(value.plan) && value.plan.every(group => isObject(group) && typeof group.id === "string"
      && Array.isArray(group.images) && group.images.length >= 2 && group.images.every(image => isObject(image) && typeof image.id === "string" && isNonNegativeInteger(image.size) && isNonNegativeInteger(image.modifiedMs))))
    && (value.nextOffset === null || (isNonNegativeInteger(value.nextOffset) && value.nextOffset > Number(value.offset) && value.nextOffset < Number(value.total)));
}
