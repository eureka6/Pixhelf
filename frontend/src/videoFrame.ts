export type VideoFrame = { file: File; time: number };

export function captureVideoFrame(video: HTMLVideoElement): Promise<VideoFrame> {
  if (video.seeking || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return Promise.reject(new Error("当前画面尚未就绪，请稍后重试。"));
  }
  const time = video.currentTime;
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("无法截取当前画面，请重试。"));
  // Copy immediately: encoding the JPEG is asynchronous, but the query must
  // retain the exact frame and timestamp selected by the viewer.
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) { reject(new Error("无法截取当前画面，请重试。")); return; }
    resolve({ file: new File([blob], `frame-${time.toFixed(3)}.jpg`, { type: "image/jpeg" }), time });
  }, "image/jpeg", .9));
}
