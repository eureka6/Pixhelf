const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}
