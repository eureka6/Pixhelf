import { createPortal } from "preact/compat";
import { Info, X } from "./icons";
import { PhotoInformation } from "./PhotoInformation";
import { imageCardById } from "./galleryViewport";
import { useModalDialog } from "./useModalDialog";
import type { GalleryImage } from "./types";

export function PhotoInformationDialog({ image, onClose }: { image: GalleryImage; onClose: () => void }) {
  const dialog = useModalDialog(onClose, {
    fallbackFocus: () => document.querySelector<HTMLElement>(".image-viewer")
      ?? imageCardById(image.id)?.querySelector<HTMLElement>(".photo-card-open") ?? null,
  });
  return createPortal(
    <dialog {...dialog} className="photo-info-dialog" data-image-id={image.id} aria-labelledby="photo-info-title">
      <header className="photo-info-header">
        <h2 id="photo-info-title"><Info size={18} />图片信息</h2>
        <button type="button" aria-label="关闭图片信息" onClick={onClose}><X size={19} /></button>
      </header>
      <div className="photo-info-body"><PhotoInformation image={image} showHeading={false} /></div>
    </dialog>, document.body,
  );
}
