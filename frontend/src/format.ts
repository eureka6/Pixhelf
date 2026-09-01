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
