import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatFileSize } from "./format";
import { chooseNetwork, networkPoints, networkSegments, type NetworkInterface, type NetworkPoint, type NetworkSample } from "./systemNetwork";
import type { NativeNetworkSample } from "./types";

const PREFERENCE_KEY = "pixhelf.system.network";
const rate = (value: number | null) => value === null ? "—" : `${formatFileSize(value)}/s`;
const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
const nativeInterval = (value: number) => value >= 60_000 ? `${Math.round(value / 6000) / 10} 分钟均值` : `${Math.round(value / 100) / 10} 秒均值`;

function preferredNetwork(): string {
  try { return localStorage.getItem(PREFERENCE_KEY) ?? ""; }
  catch { return ""; }
}

export function SystemNetwork({ interfaces, history, nativeHistory, sampledAt }: {
  interfaces: NetworkInterface[] | null; history: NetworkSample[]; nativeHistory: NativeNetworkSample[]; sampledAt: number;
}) {
  const [selected, setSelected] = useState(preferredNetwork);
  const [duration, setDuration] = useState(60_000);
  const native = duration === 86_400_000;
  const network = chooseNetwork(interfaces ?? [], selected);
  // Keep the choice stable as traffic fluctuates, and recover if an interface disappears.
  useEffect(() => {
    if (network && network.name !== selected && interfaces?.some(item => item.receiveBytesPerSecond !== null || item.sendBytesPerSecond !== null)) setSelected(network.name);
  }, [network?.name, selected, interfaces]);
  const select = (name: string) => {
    setSelected(name);
    try { localStorage.setItem(PREFERENCE_KEY, name); } catch { /* Private browsing may disable storage. */ }
  };
  return <section className="system-panel system-network" aria-labelledby="system-network-title">
    <div className="system-network-heading">
      <h2 id="system-network-title">网络流量</h2>
      {network && <div className="system-network-controls">
        <select aria-label="选择网卡" value={network.name} onChange={event => select(event.currentTarget.value)}>
          {[...(interfaces ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <div className="system-chart-period" role="group" aria-label="时间范围">
          {[{ value: 60_000, label: "1 分钟" }, { value: 300_000, label: "5 分钟" }, { value: 86_400_000, label: "24 小时" }].map(period =>
            <button key={period.value} type="button" aria-pressed={duration === period.value}
              onClick={() => setDuration(period.value)}>{period.label}</button>)}
        </div>
      </div>}
    </div>
    {!network ? <p className="system-note">{interfaces === null ? "网络信息暂不可用" : "暂无可用网卡"}</p> : <>
      <dl className="system-network-stats" aria-label={`${network.name} 流量统计`}>
        <div data-direction="receive"><dt>接收速率</dt><dd>{rate(network.receiveBytesPerSecond)}</dd></div>
        <div data-direction="send"><dt>发送速率</dt><dd>{rate(network.sendBytesPerSecond)}</dd></div>
        <div><dt>累计接收</dt><dd>{formatFileSize(network.receivedBytes)}</dd></div>
        <div><dt>累计发送</dt><dd>{formatFileSize(network.sentBytes)}</dd></div>
      </dl>
      {native && <p className="system-chart-source">系统记录</p>}
      <NetworkChart name={network.name} history={native ? nativeHistory : history} duration={duration} end={sampledAt} native={native} />
    </>}
  </section>;
}

function NetworkChart({ name, history, duration, end, native }: {
  name: string; history: NetworkSample[]; duration: number; end: number; native: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hoveredAt, setHoveredAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(180, Math.round(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setHoveredAt(null), [name, duration]);

  const start = end - duration;
  const points = useMemo(() => networkPoints(history, name, start), [history, name, start]);
  const peak = points.reduce((maximum, point) => Math.max(maximum, point.receive ?? 0, point.send ?? 0), 0);
  const maximum = 1024 * 2 ** Math.ceil(Math.log2(Math.max(1, peak * 1.1 / 1024)));
  const height = 220, left = 72, right = width - 12, top = 12, bottom = height - 28;
  const x = (at: number) => left + (at - start) / duration * (right - left);
  const y = (value: number) => bottom - value / maximum * (bottom - top);
  const hovered = points.find(point => point.at === hoveredAt);
  const hasValues = points.some(point => point.receive !== null || point.send !== null);
  const timeTicks = width < 480 ? [0, 1] : [0, 0.5, 1];
  const pointAt = (clientX: number) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect || !points.length) return;
    const at = start + (Math.min(right, Math.max(left, clientX - rect.left)) - left) / (right - left) * duration;
    setHoveredAt(points.reduce((nearest, point) => Math.abs(point.at - at) < Math.abs(nearest.at - at) ? point : nearest).at);
  };
  const path = (segment: NetworkPoint[], direction: "receive" | "send") => segment.map((point, index) =>
    `${index ? "L" : "M"}${x(point.at).toFixed(2)} ${y(point[direction]!).toFixed(2)}`).join(" ");

  return <div className="system-network-chart" ref={container}>
    <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" tabIndex={0}
      aria-label={`${name} 接收与发送速率曲线`} aria-description="左右方向键查看采样值"
      onPointerMove={event => pointAt(event.clientX)} onPointerDown={event => pointAt(event.clientX)}
      onPointerLeave={event => { if (event.pointerType !== "touch") setHoveredAt(null); }}
      onPointerCancel={() => setHoveredAt(null)} onBlur={() => setHoveredAt(null)}
      onFocus={() => setHoveredAt(current => current ?? points.at(-1)?.at ?? null)}
      onKeyDown={event => {
        if (event.key === "Escape") { setHoveredAt(null); return; }
        if (!points.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = points.findIndex(point => point.at === hoveredAt);
        const current = index < 0 ? points.length - 1 : index;
        const next = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
          : Math.max(0, Math.min(points.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1)));
        setHoveredAt(points[next].at);
      }}>
      {[0, 0.5, 1].map(fraction => <g key={fraction} className="system-chart-grid" aria-hidden="true">
        <line x1={left} x2={right} y1={y(maximum * fraction)} y2={y(maximum * fraction)} />
        <text x={left - 10} y={y(maximum * fraction) + 4} textAnchor="end">{rate(maximum * fraction)}</text>
      </g>)}
      {timeTicks.map(fraction => <text key={fraction} className="system-chart-time" aria-hidden="true"
        x={x(start + duration * fraction)} y={height - 6} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>{clock(start + duration * fraction)}</text>)}
      {(["receive", "send"] as const).map(direction => <g key={direction} className="system-chart-series" data-direction={direction}>
        {networkSegments(points, direction).map(segment => <g key={segment[0].at}>
          <path className="system-chart-line" d={path(segment, direction)} />
          {segment.length === 1 && <circle cx={x(segment[0].at)} cy={y(segment[0][direction]!)} r={2.5} />}
        </g>)}
      </g>)}
      {!hasValues && <text className="system-chart-empty" x={(left + right) / 2} y={(top + bottom) / 2} textAnchor="middle">{native ? "暂无系统记录" : "等待采样"}</text>}
      {hovered && <g className="system-chart-cursor" aria-hidden="true">
        <line x1={x(hovered.at)} x2={x(hovered.at)} y1={top} y2={bottom} />
        {(["receive", "send"] as const).map(direction => hovered[direction] !== null && <circle key={direction}
          data-direction={direction} cx={x(hovered.at)} cy={y(hovered[direction]!)} r={4} />)}
      </g>}
    </svg>
    {hovered && <div className="system-chart-tooltip" role="status" style={{ left: `${Math.max(0, Math.min(width - 174, x(hovered.at) - 82))}px` }}>
      <time dateTime={new Date(hovered.at).toISOString()}>{clock(hovered.at)}</time>
      {native && hovered.intervalMs !== undefined && hovered.intervalMs > 0 && <small>{nativeInterval(hovered.intervalMs)}</small>}
      <span data-direction="receive">接收<strong>{rate(hovered.receive)}</strong></span>
      <span data-direction="send">发送<strong>{rate(hovered.send)}</strong></span>
    </div>}
  </div>;
}
