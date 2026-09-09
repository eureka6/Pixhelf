import type { GalleryImage } from "./types";

export function appendUniqueImages(current: GalleryImage[], incoming: GalleryImage[]): GalleryImage[] {
  const ids = new Set(current.map(image => image.id));
  const unique = incoming.filter(image => {
    if (ids.has(image.id)) return false;
    ids.add(image.id);
    return true;
  });
  return unique.length ? [...current, ...unique] : current;
}
