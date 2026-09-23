import { Check } from "./icons";

export function ViewerSelectionButton({ selected, disabled, video = false, onToggle }: {
  selected: boolean; disabled?: boolean; video?: boolean; onToggle: () => void;
}) {
  const label = `${selected ? "取消选择" : "选择"}${video ? "视频" : "图片"}`;
  return <button type="button" className={`${video ? "video-control" : "viewer-control"} viewer-selection-trigger`}
    disabled={disabled} onClick={onToggle} aria-label={label} aria-pressed={selected}
    title={selected ? "已选择 · 点击取消" : label}>
    <span className="viewer-selection-orb" aria-hidden="true"><Check size={17} strokeWidth={3} /></span>
  </button>;
}
