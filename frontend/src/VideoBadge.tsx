import { formatDuration } from "./format";
import { Play } from "./icons";
import type { VideoMetadata } from "./types";

export function VideoBadge({ video }: { video: VideoMetadata }) {
  return <span className="video-badge" aria-label={`视频，${formatDuration(video.duration)}`}>
    <Play size={13} />{video.duration === null ? "视频" : formatDuration(video.duration)}
  </span>;
}
