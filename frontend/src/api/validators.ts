import type { Album, BootstrapData, DuplicatePage, GalleryImage, GallerySummary, ImagesPage,
  PhotoDetails, SystemInfo, ThumbnailStatus, VideoMetadata } from "../types";

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

export function isSystemInfo(value: unknown): value is SystemInfo {
  const nullableString = (item: unknown) => item === null || typeof item === "string";
  const nullableInteger = (item: unknown) => item === null || isNonNegativeInteger(item);
  const nonNegativeNumber = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0;
  const nullableNumber = (item: unknown) => item === null || nonNegativeNumber(item);
  const networkRate = (item: unknown) => isObject(item) && typeof item.name === "string"
    && [item.receiveBytesPerSecond, item.sendBytesPerSecond].every(nullableNumber);
  const capacity = (item: unknown) => isObject(item)
    && [item.total, item.used, item.available].every(isNonNegativeInteger)
    && Number(item.used) <= Number(item.total) && Number(item.available) <= Number(item.total);
  return isObject(value) && isNonNegativeInteger(value.sampledAtMs) && value.sampledAtMs <= 8.64e15
    && isObject(value.host) && [value.host.hostname, value.host.operatingSystem, value.host.kernel, value.host.cpuModel].every(nullableString)
    && typeof value.host.architecture === "string" && (value.host.logicalCpus === null || isPositiveInteger(value.host.logicalCpus))
    && isObject(value.cpu) && (value.cpu.usagePercent === null || (nonNegativeNumber(value.cpu.usagePercent) && value.cpu.usagePercent <= 100))
    && nullableInteger(value.cpu.uptimeSeconds)
    && (value.cpu.loadAverage === null || (Array.isArray(value.cpu.loadAverage) && value.cpu.loadAverage.length === 3 && value.cpu.loadAverage.every(nonNegativeNumber)))
    && (value.memory === null || (isObject(value.memory) && capacity(value.memory)
      && [value.memory.swapTotal, value.memory.swapUsed].every(isNonNegativeInteger) && Number(value.memory.swapUsed) <= Number(value.memory.swapTotal)))
    && isObject(value.process) && typeof value.process.version === "string" && isPositiveInteger(value.process.pid)
    && isNonNegativeInteger(value.process.uptimeSeconds) && [value.process.residentMemory, value.process.threads].every(nullableInteger)
    && Array.isArray(value.storage) && value.storage.every(directory => isObject(directory) && typeof directory.name === "string" && typeof directory.path === "string"
      && nullableInteger(directory.sizeBytes) && (directory.state === "scanning" || directory.state === "error" || (directory.state === "ready" && isNonNegativeInteger(directory.sizeBytes))))
    && (value.network === null || (Array.isArray(value.network) && value.network.every(network => isObject(network) && typeof network.name === "string"
      && [network.receivedBytes, network.sentBytes].every(isNonNegativeInteger) && [network.receiveBytesPerSecond, network.sendBytesPerSecond].every(nullableNumber))))
    && Array.isArray(value.networkHistory) && value.networkHistory.length > 0 && value.networkHistory.length <= 151
    && value.networkHistory.every((sample, index, history) => isObject(sample) && isNonNegativeInteger(sample.at)
      && sample.at <= Number(value.sampledAtMs) && sample.at >= Number(value.sampledAtMs) - 300_000
      && (index === 0 || sample.at > history[index - 1].at)
      && (sample.interfaces === null || (Array.isArray(sample.interfaces) && sample.interfaces.every(networkRate))))
    && value.networkHistory.at(-1).at === value.sampledAtMs
    && Array.isArray(value.nativeNetworkHistory) && value.nativeNetworkHistory.length <= 1441
    && value.nativeNetworkHistory.every((sample, index, history) => isObject(sample) && isNonNegativeInteger(sample.at)
      && sample.at <= Number(value.sampledAtMs) && sample.at >= Number(value.sampledAtMs) - 86_400_000
      && (index === 0 || sample.at > history[index - 1].at)
      && nonNegativeNumber(sample.intervalSeconds) && sample.intervalSeconds <= 86400
      && (sample.interfaces === null || (sample.intervalSeconds > 0 && Array.isArray(sample.interfaces) && sample.interfaces.every(networkRate))))
    && isObject(value.gallery) && [value.gallery.total, value.gallery.albums].every(isNonNegativeInteger) && typeof value.gallery.initializing === "boolean"
    && isThumbnailStatus(value.jobs);
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
