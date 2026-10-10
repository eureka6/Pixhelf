type Box = { type: string; start: number; end: number };
const containers = new Set(["trak", "mdia", "minf", "stbl"]);
const videoCodecs = new Set(["avc1", "avc3", "hvc1", "hev1"]);

function boxAt(data: DataView, offset: number, end: number): Box | undefined {
  if (offset + 8 > data.byteLength || offset + 8 > end) return;
  let size = data.getUint32(offset), header = 8;
  if (size === 1) {
    if (offset + 16 > data.byteLength) return;
    const extended = data.getBigUint64(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return;
    size = Number(extended);
    header = 16;
  } else if (size === 0) size = end - offset;
  if (size < header || size > end - offset) return;
  const type = String.fromCharCode(...new Uint8Array(data.buffer, data.byteOffset + offset + 4, 4));
  return { type, start: offset + header, end: offset + size };
}

function videoCodec(data: DataView, start: number, end: number, depth = 0): string | undefined {
  for (let position = start; position < end;) {
    const box = boxAt(data, position, end);
    if (!box) return;
    if (box.type === "stsd" && box.end - box.start >= 8) {
      const count = data.getUint32(box.start + 4);
      let entryStart = box.start + 8;
      for (let i = 0; i < Math.min(count, 256) && entryStart < box.end; i++) {
        const entry = boxAt(data, entryStart, box.end);
        if (!entry) return;
        if (videoCodecs.has(entry.type)) return entry.type;
        entryStart = entry.end;
      }
    } else if (depth < 4 && containers.has(box.type)) {
      const codec = videoCodec(data, box.start, box.end, depth + 1);
      if (codec) return codec;
    }
    position = box.end;
  }
}

// Read the MOV/MP4 sample description, skipping compressed media altogether.
// Unknown or malformed metadata keeps the ordinary native/fallback path.
export async function motionVideoCodec(blob: Blob): Promise<string | undefined> {
  let position = 0;
  for (let count = 0; count < 256 && position + 8 <= blob.size; count++) {
    const header = new DataView(await blob.slice(position, position + 16).arrayBuffer());
    const box = boxAt(header, 0, blob.size - position);
    if (!box) return;
    if (box.type === "moov") {
      if (box.end - box.start > 2 * 1024 * 1024) return;
      const movie = new DataView(await blob.slice(position + box.start, position + box.end).arrayBuffer());
      return videoCodec(movie, 0, movie.byteLength);
    }
    position += box.end;
  }
}
