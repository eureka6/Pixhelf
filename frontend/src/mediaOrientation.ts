export type MediaOrientation = { rotation: number; mirrored: boolean };

// MOV/MP4 display matrices describe both rotation and reflection. Limit this
// correction to orthogonal camera orientations; leave other transforms intact.
export function mediaOrientation(matrix: unknown): MediaOrientation | undefined {
  if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(Number.isFinite)) return;
  const [a, b, u, c, d, v] = matrix as number[];
  const area = Math.hypot(a, b) * Math.hypot(c, d);
  if (!area || u || v || Math.abs((a * c + b * d) / area) > .0001) return;
  const angle = Math.atan2(-c, d) * 180 / Math.PI;
  const quarterTurn = Math.round(angle / 90) * 90;
  if (Math.abs(angle - quarterTurn) > .01) return;
  const rotation = (quarterTurn + 360) % 360, mirrored = a * d - b * c < 0;
  return rotation || mirrored ? { rotation, mirrored } : undefined;
}
