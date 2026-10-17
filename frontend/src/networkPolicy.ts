type Connection = { saveData?: boolean; effectiveType?: string; downlink?: number; rtt?: number };

const connectionInfo = () => (navigator as Navigator & { connection?: Connection }).connection;

export function limitedBandwidth(): boolean {
  const connection = connectionInfo();
  if (connection?.saveData) return true;
  // Prefer the reported transfer rate over the coarse connection category.
  if (connection?.downlink && connection.downlink > 0) return connection.downlink <= 2;
  return /^(slow-)?[23]g$/.test(connection?.effectiveType ?? "");
}

// RTT matters even on a fast local connection when the server is far away.
// Navigation timing also covers browsers without the Network Information API.
export function constrainedNetwork(): boolean {
  if (limitedBandwidth()) return true;
  const connection = connectionInfo();
  if (/^(slow-)?[23]g$/.test(connection?.effectiveType ?? "")) return true;
  if (connection?.rtt && connection.rtt >= 200) return true;
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return Boolean(navigation?.requestStart && navigation.responseStart - navigation.requestStart >= 250);
}

export function canPrefetchMedia(): boolean {
  return document.visibilityState === "visible" && !constrainedNetwork();
}

// Inside an open viewer, use idle bandwidth for the next original. Save-Data
// remains an explicit opt-out; slow links use a single forward neighbor.
export function canPrefetchViewerOriginals(): boolean {
  return document.visibilityState === "visible" && !connectionInfo()?.saveData;
}
