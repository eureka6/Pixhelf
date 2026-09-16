const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");
const FILE_SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${COUNT_FORMATTER.format(bytes)} B`;
  let value = bytes / 1024;
  let unit: string = FILE_SIZE_UNITS[0];
  for (let index = 1; index < FILE_SIZE_UNITS.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = FILE_SIZE_UNITS[index];
  }
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${unit}`;
}

export function formatPixelCount(megapixels: number): string {
  return megapixels >= 1
    ? `${megapixels.toFixed(1)} MP`
    : `${Math.round(megapixels * 1000)} KP`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "时长未知";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}
