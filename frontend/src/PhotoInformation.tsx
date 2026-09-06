import { memo } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { getPhotoDetails } from "./api";
import { formatFileSize, formatPixelCount } from "./format";
import { RefreshCw } from "./icons";
import { HistogramLegend, PhotoHistogram } from "./PhotoHistogram";
import type {
  GalleryImage,
  PhotoDetails,
  PhotoExifField,
} from "./types";

type PhotoInformationProps = {
  image: GalleryImage;
};

type ShootingParameter = {
  kind: "focal" | "aperture" | "shutter" | "iso";
  label: string;
  value: string;
};

type InformationField = {
  label: string;
  value: string | null;
  kind?: string;
};

type ImageInformationPanelProps = PhotoInformationProps & {
  details: PhotoDetails | null;
  loading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
};

type DetailsState =
  | { imageId: string; status: "loading" }
  | { imageId: string; status: "ready"; details: PhotoDetails }
  | { imageId: string; status: "error"; message: string };

const DEVICE_EXIF_LABELS = ["相机", "镜头", "焦距", "35mm 等效"] as const;
const GROUPED_EXIF_LABELS: ReadonlySet<string> = new Set([
  "拍摄时间",
  "色彩空间",
  "相机",
  "镜头",
  "焦距",
  "35mm 等效",
  "光圈",
  "快门",
  "ISO",
]);

function shootingParameter(
  field: PhotoExifField | undefined,
  kind: ShootingParameter["kind"],
  label: string,
  format: (value: string) => string = (value) => value,
): ShootingParameter | null {
  return field ? { kind, label, value: format(field.value) } : null;
}

function InformationList({
  fields,
  className = "",
}: {
  fields: InformationField[];
  className?: string;
}) {
  return (
    <dl className={`viewer-image-information-list ${className}`.trim()}>
      {fields.map((field) => (
        <div
          key={field.kind ?? `${field.label}-${field.value}`}
          data-info-kind={field.kind}
        >
          <dt>{field.label}</dt>
          <dd title={field.value ?? undefined}>
            {field.value ?? <span className="viewer-image-information-value-skeleton" />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function InformationSection({
  title,
  fields,
  listClassName,
}: {
  title: string;
  fields: InformationField[];
  listClassName?: string;
}) {
  return (
    <section className="viewer-image-information-group">
      <h4>{title}</h4>
      <InformationList fields={fields} className={listClassName} />
    </section>
  );
}

function ImageInformationPanel({
  image,
  details,
  loading,
  errorMessage,
  onRetry,
}: ImageInformationPanelProps) {
  const fileExtension = image.name.includes(".")
    ? image.name.split(".").pop()?.toLocaleUpperCase() ?? "图片"
    : "图片";
  const orientation = image.width === image.height
    ? "方形"
    : image.width > image.height
      ? "横向"
      : "竖向";
  const megapixels = image.width * image.height / 1_000_000;
  const exif = details?.exif ?? [];
  const fieldByLabel = new Map(exif.map((field) => [field.label, field]));
  const capturedAt = fieldByLabel.get("拍摄时间");
  const colorSpace = fieldByLabel.get("色彩空间");
  const shootingFocal = fieldByLabel.get("35mm 等效") ?? fieldByLabel.get("焦距");
  const shooting = [
    shootingParameter(
      shootingFocal,
      "focal",
      shootingFocal?.label === "35mm 等效" ? "等效焦距" : "焦距",
    ),
    shootingParameter(fieldByLabel.get("光圈"), "aperture", "光圈"),
    shootingParameter(fieldByLabel.get("快门"), "shutter", "快门速度"),
    shootingParameter(
      fieldByLabel.get("ISO"),
      "iso",
      "感光度",
      (value) => `ISO ${value.replace(/^ISO\s*/i, "")}`,
    ),
  ].filter((parameter): parameter is ShootingParameter => parameter !== null);
  const devices = DEVICE_EXIF_LABELS.flatMap((label) => {
    const field = fieldByLabel.get(label);
    return field ? [field] : [];
  });
  const additional = exif.filter((field) => !GROUPED_EXIF_LABELS.has(field.label));
  const basicInformation: InformationField[] = [
    { label: "文件名", value: image.name, kind: "filename" },
    { label: "格式", value: fileExtension, kind: "format" },
    {
      label: "尺寸",
      value: `${image.width.toLocaleString()} × ${image.height.toLocaleString()}`,
      kind: "dimensions",
    },
    {
      label: "文件大小",
      value: details ? formatFileSize(details.fileSize) : errorMessage ? "读取失败" : null,
      kind: "file-size",
    },
    { label: "像素", value: formatPixelCount(megapixels), kind: "pixels" },
    ...(colorSpace
      ? [{ label: "色彩空间", value: colorSpace.value, kind: "color-space" }]
      : []),
    { label: "方向", value: orientation, kind: "orientation" },
    ...(capturedAt
      ? [{ label: "拍摄时间", value: capturedAt.value, kind: "captured" }]
      : []),
  ];

  return (
    <div className="viewer-image-information-panel">
      <div className="viewer-image-information-overview">
        <InformationSection
          title="基本信息"
          fields={basicInformation}
          listClassName="viewer-image-information-basic"
        />

        <section className="viewer-image-information-group viewer-image-information-histogram">
          <div className="viewer-image-information-group-heading">
            <h4>影调分布</h4>
            <HistogramLegend />
          </div>
          {details ? (
            <PhotoHistogram histogram={details.histogram} imageId={image.id} />
          ) : errorMessage ? (
            <PhotoDataError message={errorMessage} onRetry={onRetry} />
          ) : (
            <div className="viewer-histogram-card is-loading" aria-busy="true">
              <div className="viewer-photo-data-skeleton" />
            </div>
          )}
        </section>
      </div>

      {shooting.length > 0 && (
        <section className="viewer-image-information-group">
          <h4>拍摄参数</h4>
          <dl className="viewer-image-information-exposure">
            {shooting.map((parameter) => (
              <div key={parameter.kind} data-exposure-kind={parameter.kind}>
                <dt>{parameter.label}</dt>
                <dd title={`${parameter.label}：${parameter.value}`}>{parameter.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {(devices.length > 0 || additional.length > 0) && (
        <div className="viewer-image-information-metadata">
          {devices.length > 0 && (
            <InformationSection title="设备信息" fields={devices} />
          )}

          {additional.length > 0 && (
            <InformationSection title="其他信息" fields={additional} />
          )}
        </div>
      )}

      {loading && (
        <div className="viewer-image-information-loading" aria-label="正在读取拍摄信息">
          <span /><span /><span />
        </div>
      )}

      {details && exif.length === 0 && (
        <div className="viewer-image-information-empty">无拍摄参数</div>
      )}
    </div>
  );
}

function PhotoDataError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="viewer-photo-data-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        <RefreshCw size={15} />
        重试
      </button>
    </div>
  );
}

function usePhotoDetails(imageId: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailsState>({
    imageId,
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ imageId, status: "loading" });
    void getPhotoDetails(imageId, controller.signal)
      .then((details) => {
        if (!controller.signal.aborted) {
          setState({ imageId, status: "ready", details });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          imageId,
          status: "error",
          message: error instanceof Error ? error.message : "无法读取照片信息",
        });
      });
    return () => controller.abort();
  }, [imageId, attempt]);

  const currentState = state.imageId === imageId
    ? state
    : { imageId, status: "loading" } as const;
  return {
    details: currentState.status === "ready" ? currentState.details : null,
    loading: currentState.status === "loading",
    errorMessage: currentState.status === "error" ? currentState.message : null,
    retry: () => setAttempt((value) => value + 1),
  };
}

export const PhotoInformation = memo(function PhotoInformation({
  image,
}: PhotoInformationProps) {
  const { details, loading, errorMessage, retry } = usePhotoDetails(image.id);

  return (
    <section className="viewer-photo-information" aria-label="图片信息">
      <header className="viewer-photo-heading">
        <h3>图片详情</h3>
      </header>
      <ImageInformationPanel
        image={image}
        details={details}
        loading={loading}
        errorMessage={errorMessage}
        onRetry={retry}
      />
    </section>
  );
});
