import type { NativeNetworkSample, NetworkHistorySample, SystemInfo } from "./types";

export type NetworkInterface = NonNullable<SystemInfo["network"]>[number];
export type NetworkSample = NetworkHistorySample | NativeNetworkSample;
export interface NetworkPoint { at: number; receive: number | null; send: number | null; intervalMs?: number }

const MAX_SAMPLE_GAP_MS = 10_000;

export function chooseNetwork(interfaces: NetworkInterface[], selected: string): NetworkInterface | undefined {
  const existing = interfaces.find(network => network.name === selected);
  if (existing) return existing;
  return interfaces.reduce<NetworkInterface | undefined>((best, network) => {
    if (!best) return network;
    const rate = (item: NetworkInterface) => (item.receiveBytesPerSecond ?? 0) + (item.sendBytesPerSecond ?? 0);
    return rate(network) > rate(best) || (rate(network) === rate(best)
      && network.receivedBytes + network.sentBytes > best.receivedBytes + best.sentBytes) ? network : best;
  }, undefined);
}

export function networkPoints(history: NetworkSample[], name: string, start: number): NetworkPoint[] {
  return history.filter(sample => sample.at >= start).map(sample => {
    const network = sample.interfaces?.find(network => network.name === name);
    return { at: sample.at, receive: network?.receiveBytesPerSecond ?? null, send: network?.sendBytesPerSecond ?? null,
      ...("intervalSeconds" in sample ? { intervalMs: sample.intervalSeconds * 1000 } : {}) };
  });
}

export function networkSegments(points: NetworkPoint[], direction: "receive" | "send"): NetworkPoint[][] {
  const segments: NetworkPoint[][] = [];
  let current: NetworkPoint[] = [];
  for (const point of points) {
    const previous = current.at(-1);
    const maxGap = point.intervalMs === undefined ? MAX_SAMPLE_GAP_MS : point.intervalMs + 2000;
    if (point[direction] === null || (previous && point.at - previous.at > maxGap)) current = [];
    if (point[direction] === null) continue;
    if (!current.length) segments.push(current);
    current.push(point);
  }
  return segments;
}
