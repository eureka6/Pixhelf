import { memo } from "preact/compat";
import { useId } from "preact/hooks";
import type { PhotoHistogram as HistogramData } from "./types";

const BOTTOM = 96;
const CHANNELS = [
  { key: "luminance", label: "亮度" },
  { key: "red", label: "红" },
  { key: "green", label: "绿" },
  { key: "blue", label: "蓝" },
] as const;

function area(values: number[], maximum: number): string {
  const points = values.map((value, index) => {
    const y = BOTTOM - value / maximum * (BOTTOM - 5);
    return `L${index} ${y.toFixed(2)}`;
  });
  return `M0 ${BOTTOM} ${points.join(" ")} L255 ${BOTTOM} Z`;
}

export function HistogramLegend() {
  return (
    <div className="viewer-histogram-legend" aria-label="直方图通道">
      {CHANNELS.map(({ key, label }) => (
        <span key={key} data-channel={key}>{label}</span>
      ))}
    </div>
  );
}

export const PhotoHistogram = memo(function PhotoHistogram({
  histogram,
  imageId,
}: {
  histogram: HistogramData;
  imageId: string;
}) {
  const maximum = Math.max(
    1,
    ...histogram.red,
    ...histogram.green,
    ...histogram.blue,
    ...histogram.luminance,
  );
  const titleId = `photo-histogram-${imageId}-${useId()}`;

  return (
    <div className="viewer-histogram-card">
      <svg
        className="viewer-histogram"
        viewBox="0 0 255 100"
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>照片的红、绿、蓝和亮度分布直方图</title>
        <g className="viewer-histogram-grid" aria-hidden="true">
          <path d="M0 24.5H255 M0 48.5H255 M0 72.5H255" />
          <path d="M63.5 0V96 M127.5 0V96 M191.5 0V96" />
        </g>
        {CHANNELS.map(({ key }) => (
          <path
            key={key}
            className={`viewer-histogram-channel viewer-histogram-${key}`}
            d={area(histogram[key], maximum)}
          />
        ))}
      </svg>
      <div className="viewer-histogram-axis" aria-hidden="true">
        <span>暗部</span>
        <span>中间调</span>
        <span>高光</span>
      </div>
    </div>
  );
});
