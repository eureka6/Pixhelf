type Connection = { saveData?: boolean; effectiveType?: string; downlink?: number; rtt?: number };

// RTT matters even on a fast local connection when the server is far away.
// Navigation timing also covers browsers without the Network Information API.
export function constrainedNetwork(): boolean {
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  if (connection?.saveData || /^(slow-)?[23]g$/.test(connection?.effectiveType ?? "")) return true;
  if (connection?.downlink && connection.downlink <= 2) return true;
  if (connection?.rtt && connection.rtt >= 200) return true;
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return Boolean(navigation?.requestStart && navigation.responseStart - navigation.requestStart >= 250);
}

export function canPrefetchMedia(): boolean {
  return document.visibilityState === "visible" && !constrainedNetwork();
}
