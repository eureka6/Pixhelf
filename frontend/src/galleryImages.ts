import type { GalleryImage } from "./types";

export function appendUniqueImages(current: GalleryImage[], incoming: GalleryImage[]): GalleryImage[] {
  if (!incoming.length) return current;
  if (incoming.length === 1) {
    const image = incoming[0]!;
    return current.some(candidate => candidate.id === image.id) ? current : [...current, image];
  }
  const ids = new Set(current.map(image => image.id));
  const unique = incoming.filter(image => {
    if (ids.has(image.id)) return false;
    ids.add(image.id);
    return true;
  });
  return unique.length ? [...current, ...unique] : current;
}
