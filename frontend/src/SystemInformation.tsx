import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getSystemInfo } from "./api";
import { errorMessage } from "./app/errors";
import { startVisiblePolling } from "./app/visiblePolling";
import { formatCount, formatFileSize } from "./format";
import { Activity, LoaderCircle, RefreshCw } from "./icons";
import { SystemNetwork } from "./SystemNetwork";
import type { BackgroundJobStatus, SystemInfo } from "./types";
import "./systemInformation.css";

const unavailable = "暂不可用";
const bytes = (value: number | null | undefined) => value == null ? unavailable : formatFileSize(value);
const percent = (used: number, total: number) => total > 0 ? Math.min(100, used / total * 100) : 0;
const percentText = (value: number | null) => value === null ? unavailable : `${value.toFixed(1)}%`;

function uptime(value: number | null): string {
  if (value === null) return unavailable;
  const days = Math.floor(value / 86400), hours = Math.floor(value / 3600) % 24, minutes = Math.floor(value / 60) % 60;
  return days ? `${formatCount(days)} 天 ${hours} 小时 ${minutes} 分钟`
    : hours ? `${hours} 小时 ${minutes} 分钟` : minutes ? `${minutes} 分钟` : `${Math.floor(value)} 秒`;
}

function Meter({ value, label }: { value: number | null; label: string }) {
  return value === null ? <div className="system-meter system-meter-unavailable" aria-hidden="true" />
    : <div className="system-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Number(value.toFixed(1))} data-high={value >= 90}>
      <span style={{ width: `${value}%` }} />
    </div>;
}

function Detail({ label, children }: { label: string; children: ComponentChildren }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Job({ label, job, disabled = false, initializing }: {
  label: string; job: BackgroundJobStatus; disabled?: boolean; initializing: boolean;
}) {
  const state = initializing ? "等待扫描" : disabled ? "未启用" : !job.total ? "暂无任务"
    : job.backgroundComplete ? job.failed ? "已结束，有失败任务" : "已完成" : "处理中";
  return <div className="system-job">
    <div className="system-row"><strong>{label}</strong><span data-failed={job.failed > 0}>{state}</span></div>
    {!disabled && !initializing && job.total > 0 && <>
      <progress aria-label={`${label}完成进度`} value={job.ready} max={job.total} />
      <div className="system-job-counts"><span>完成 {formatCount(job.ready)} / {formatCount(job.total)}</span>
        <span>排队 {formatCount(job.queued)} · 处理中 {formatCount(job.processing)} · 失败 {formatCount(job.failed)}</span></div>
    </>}
  </div>;
}

export function SystemInformation() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [online, setOnline] = useState(navigator.onLine !== false);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  useEffect(() => startVisiblePolling(async signal => {
    setRefreshing(true);
    try {
      const next = await getSystemInfo(signal);
      if (!signal.aborted) {
        setInfo(next);
        setError("");
      }
      return 2000;
    } catch (reason) {
      if (!signal.aborted) setError(errorMessage(reason, "无法读取系统信息"));
      return 5000;
    } finally {
      if (!signal.aborted) setRefreshing(false);
    }
  }, 0), [refresh]);

  const memoryUsage = info?.memory ? percent(info.memory.used, info.memory.total) : null;
  return <section className="system-information" aria-labelledby="system-information-title">
    <header className="system-heading">
      <h1 id="system-information-title"><Activity size={22} />系统信息</h1>
      <button type="button" className="icon-button" onClick={() => setRefresh(value => value + 1)} disabled={refreshing || !online}
        aria-label="刷新系统信息" title="刷新系统信息"><RefreshCw size={18} className={refreshing ? "spin" : undefined} /></button>
    </header>

    {(!online || error) && <div className="error-banner" role="alert">
      <span>{!online ? "网络已断开" : error}{info && "（数据未更新）"}</span>
    </div>}
    {!info && !error && online && <div className="system-loading" role="status"><LoaderCircle className="spin" size={22} />正在读取系统信息…</div>}

    {info && <>
      <div className="system-metrics">
        <section className="system-panel system-metric" aria-label="CPU">
          <h2>CPU 使用率</h2><strong className="system-metric-value">{percentText(info.cpu.usagePercent)}</strong>
          <Meter value={info.cpu.usagePercent} label="CPU 使用率" />
          <p>{info.host.logicalCpus === null ? "逻辑处理器数量未知" : `${formatCount(info.host.logicalCpus)} 个逻辑处理器`}</p>
          <p>平均负载（1 / 5 / 15 分钟）<br /><span className="system-numeric">{info.cpu.loadAverage?.map(value => value.toFixed(2)).join(" / ") ?? unavailable}</span></p>
        </section>
        <section className="system-panel system-metric" aria-label="内存">
          <h2>内存使用率</h2><strong className="system-metric-value">{percentText(memoryUsage)}</strong>
          <Meter value={memoryUsage} label="内存使用率" />
          <p>已用 {bytes(info.memory?.used)} / {bytes(info.memory?.total)}</p>
          <p>可用 {bytes(info.memory?.available)}<br />交换空间 {info.memory?.swapTotal === 0 ? "未启用" : `${bytes(info.memory?.swapUsed)} / ${bytes(info.memory?.swapTotal)}`}</p>
        </section>
        <section className="system-panel system-metric system-storage" aria-label="存储">
          <h2>存储</h2>
          {info.storage.map(directory => <div key={directory.name} className="system-storage-item" aria-label={directory.name}>
            <h3>{directory.name}</h3>
            <strong className="system-storage-size">{directory.sizeBytes !== null ? bytes(directory.sizeBytes) : directory.state === "scanning" ? "统计中…" : unavailable}</strong>
            <p className="system-path">{directory.path || unavailable}</p>
            {directory.state === "error" && <span className="system-storage-error" role="status">统计失败{directory.sizeBytes !== null && "（数据未更新）"}</span>}
          </div>)}
        </section>
        <section className="system-panel system-metric" aria-label="应用进程">
          <h2>Pixhelf 内存占用</h2><strong className="system-metric-value">{bytes(info.process.residentMemory)}</strong>
          <p>已运行 {uptime(info.process.uptimeSeconds)}</p>
          <dl className="system-details system-process-details">
            <Detail label="应用版本">v{info.process.version}</Detail>
            <Detail label="进程 / 线程">{info.process.pid} / {info.process.threads ?? unavailable}</Detail>
          </dl>
        </section>
      </div>

      <SystemNetwork interfaces={info.network} history={info.networkHistory} nativeHistory={info.nativeNetworkHistory} sampledAt={info.sampledAtMs} />

      <div className="system-columns">
        <section className="system-panel" aria-labelledby="system-host-title">
          <h2 id="system-host-title">主机信息</h2>
          <dl className="system-details">
            <Detail label="主机名">{info.host.hostname ?? unavailable}</Detail>
            <Detail label="操作系统">{info.host.operatingSystem ?? unavailable}</Detail>
            <Detail label="内核版本">{info.host.kernel ?? unavailable}</Detail>
            <Detail label="处理器">{info.host.cpuModel ?? unavailable}</Detail>
            <Detail label="架构">{info.host.architecture}</Detail>
            <Detail label="系统运行时长">{uptime(info.cpu.uptimeSeconds)}</Detail>
          </dl>
        </section>
        <section className="system-panel" aria-labelledby="system-jobs-title">
          <div className="system-row"><h2 id="system-jobs-title">后台任务</h2>{info.gallery.initializing && <span>正在扫描</span>}</div>
          <p className="system-gallery-count">{formatCount(info.gallery.total)} 个媒体文件<span>·</span>{formatCount(info.gallery.albums)} 个相册</p>
          <Job label="缩略图" job={info.jobs} initializing={info.gallery.initializing} />
          <Job label="文字搜索索引" job={info.jobs.textSearch} disabled={!info.jobs.textSearch.enabled} initializing={info.gallery.initializing} />
          {info.jobs.videos && <>
            <Job label="视频播放" job={info.jobs.videos.playback} initializing={info.gallery.initializing} />
            <Job label="视频预览" job={info.jobs.videos.preview} initializing={info.gallery.initializing} />
          </>}
        </section>
      </div>

    </>}
  </section>;
}
