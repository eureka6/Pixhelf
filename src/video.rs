use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::Serialize;
use serde_json::Value;

use crate::gallery::ImageRecord;

// Exclude playlists and network protocols: gallery entries are local media files.
// Extensions are not demuxer names: .mpg may use mpegvideo, .m4v may use
// mov or m4v, and MJPEG can be detected as mjpeg or jpeg_pipe.
const INPUT_FORMATS: &str = "mov,matroska,webm,avi,ogg,flv,asf,mpegts,mpeg,mpegvideo,m4v,hevc,h264,mjpeg,jpeg_pipe,mxf,rm,swf,wtv";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub duration: Option<f64>,
    pub codec: String,
    pub audio_codec: Option<String>,
    pub frame_rate: Option<f64>,
    pub container: String,
    #[serde(skip)]
    pub(crate) stream_index: u64,
}

pub fn mime_type(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "mp4" | "m4v" | "f4v" => "video/mp4",
            "mov" => "video/quicktime",
            "webm" => "video/webm",
            "mkv" => "video/x-matroska",
            "avi" => "video/x-msvideo",
            "ogv" | "ogg" => "video/ogg",
            "3gp" => "video/3gpp",
            "3g2" => "video/3gpp2",
            "flv" => "video/x-flv",
            "wmv" | "asf" => "video/x-ms-wmv",
            "ts" | "mts" | "m2ts" => "video/mp2t",
            "mpg" | "mpeg" | "mpe" | "m1v" | "m2v" | "vob" => "video/mpeg",
            "mjpeg" | "mjpg" => "video/x-mjpeg",
            "mxf" => "application/mxf",
            "rm" | "rmvb" => "application/vnd.rn-realmedia",
            "swf" => "application/x-shockwave-flash",
            "wtv" => "video/x-ms-wtv",
            "hevc" | "h265" => "video/h265",
            "h264" | "264" => "video/h264",
            _ => return None,
        },
    )
}

pub fn probe(path: &Path) -> Result<(u32, u32, VideoMetadata)> {
    let mut command = Command::new("ffprobe");
    command.args(["-v", "error"]);
    input_options(&mut command, path)?;
    command.args([
        "-show_entries",
        "stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,duration:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration",
        "-of", "json",
    ]);
    let output = run_bounded(&mut command, 1024 * 1024)?;
    parse_probe(&serde_json::from_slice(&output).context("invalid ffprobe response")?)
}

pub(crate) fn input_options(command: &mut Command, path: &Path) -> Result<()> {
    command
        .args([
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            INPUT_FORMATS,
            "-probesize",
            "8388608",
            "-analyzeduration",
            "5000000",
            "-threads",
            "1",
            "-i",
        ])
        .arg(path.canonicalize().context("cannot resolve video path")?);
    Ok(())
}

fn positive(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn ratio(value: Option<&Value>, separator: char) -> Option<f64> {
    let (numerator, denominator) = value?.as_str()?.split_once(separator)?;
    let result = numerator.parse::<f64>().ok()? / denominator.parse::<f64>().ok()?;
    (result.is_finite() && result > 0.0).then_some(result)
}

fn parse_probe(value: &Value) -> Result<(u32, u32, VideoMetadata)> {
    let streams = value["streams"]
        .as_array()
        .context("video has no streams")?;
    let stream = streams
        .iter()
        .find(|stream| {
            stream["codec_type"] == "video"
                && stream["disposition"]["attached_pic"] != 1
                && positive(stream.get("width")).is_some()
                && positive(stream.get("height")).is_some()
        })
        .context("file has no playable video stream")?;
    let sar = ratio(stream.get("sample_aspect_ratio"), ':').unwrap_or(1.0);
    let mut width = (positive(stream.get("width")).unwrap() * sar).round();
    let mut height = positive(stream.get("height")).unwrap();
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|data| data.iter().find_map(|entry| entry["rotation"].as_f64()))
        .or_else(|| stream["tags"]["rotate"].as_str()?.parse::<f64>().ok())
        .unwrap_or(0.0);
    if rotation.is_finite() && (rotation.round() as i64).rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    ensure!(
        (1.0..=65536.0).contains(&width) && (1.0..=65536.0).contains(&height),
        "invalid video dimensions"
    );
    let format = &value["format"];
    Ok((
        width as u32,
        height as u32,
        VideoMetadata {
            duration: positive(format.get("duration")).or_else(|| positive(stream.get("duration"))),
            codec: stream["codec_name"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned(),
            audio_codec: streams
                .iter()
                .find(|stream| stream["codec_type"] == "audio")
                .and_then(|stream| stream["codec_name"].as_str())
                .map(str::to_owned),
            frame_rate: ratio(stream.get("avg_frame_rate"), '/')
                .or_else(|| ratio(stream.get("r_frame_rate"), '/')),
            container: format["format_name"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned(),
            stream_index: stream["index"]
                .as_u64()
                .context("video stream has no index")?,
        },
    ))
}

pub fn thumbnail(record: &ImageRecord, edge: u32) -> Result<image::DynamicImage> {
    let video = record.video.as_ref().context("not a video")?;
    let scale = (f64::from(edge) / f64::from(record.width.max(record.height))).min(1.0);
    let width = (f64::from(record.width) * scale).round().max(1.0) as u32;
    let height = (f64::from(record.height) * scale).round().max(1.0) as u32;
    // Seek only when the container supplies a duration; raw streams may not be seekable.
    let seek = video.duration.map(|duration| (duration * 0.1).min(3.0));
    let extract = |seek: Option<f64>| -> Result<image::DynamicImage> {
        let mut command = Command::new("ffmpeg");
        command.args(["-v", "error", "-nostdin"]);
        if let Some(seek) = seek {
            command.arg("-ss").arg(format!("{seek:.3}"));
        }
        input_options(&mut command, &record.path)?;
        command.args([
            "-map",
            &format!("0:{}", video.stream_index),
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &format!("scale={width}:{height},setsar=1"),
            "-threads",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "pipe:1",
        ]);
        let bytes = run_bounded(&mut command, 4 * 1024 * 1024)?;
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .context("cannot decode video thumbnail")
    };
    match extract(seek) {
        Ok(image) => Ok(image),
        Err(_) if seek.is_some() => extract(None),
        Err(error) => Err(error),
    }
}

// Bound runtime and captured output so a damaged file cannot stall a scanner/worker
// indefinitely. Drain both pipes concurrently, and always reap the child.
fn run_bounded(command: &mut Command, limit: usize) -> Result<Vec<u8>> {
    run_cancellable(command, limit, PROCESS_TIMEOUT, &|| false)
}

pub(crate) fn run_cancellable(
    command: &mut Command,
    limit: usize,
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>> {
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("cannot start {program}; install FFmpeg (ffmpeg and ffprobe)"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |source: Box<dyn Read + Send>, cap: usize| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            source
                .take(cap as u64 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        })
    };
    let output = read(Box::new(stdout), limit);
    let errors = read(Box::new(stderr), 16 * 1024);
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout && !cancelled() => {
                thread::sleep(Duration::from_millis(20))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(match result {
                    Err(error) => anyhow!(error),
                    _ if cancelled() => anyhow!("{program} cancelled"),
                    _ => anyhow!("{program} timed out"),
                });
            }
        }
    };
    let output = output
        .join()
        .map_err(|_| anyhow!("{program} output reader stopped"))??;
    let errors = errors
        .join()
        .map_err(|_| anyhow!("{program} error reader stopped"))??;
    if !status?.success() {
        bail!("{program} failed: {}", String::from_utf8_lossy(&errors));
    }
    ensure!(output.len() <= limit, "{program} output exceeded limit");
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn video_format_variants_are_indexed_and_generate_thumbnails() {
        let temp = tempfile::tempdir().unwrap();
        let cases = [
            ("raw.mpg", "mpeg2video", "mpeg2video", "mpegvideo"),
            ("raw.m2v", "mpeg2video", "mpeg2video", "mpegvideo"),
            ("raw.m4v", "mpeg4", "m4v", "m4v"),
            ("raw.mjpeg", "mjpeg", "mjpeg", "mjpeg"),
            ("single-frame.mjpeg", "mjpeg", "image2pipe", "jpeg_pipe"),
            ("clip.mxf", "mpeg2video", "mxf", "mxf"),
            ("clip.rm", "rv10", "rm", "rm"),
            ("clip.swf", "flv", "swf", "swf"),
            ("clip.wtv", "mpeg2video", "wtv", "wtv"),
        ];
        for (name, codec, muxer, _) in cases {
            let mut command = Command::new("ffmpeg");
            command.args([
                "-v",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=64x48:rate=25",
                "-t",
                "0.24",
                "-an",
                "-c:v",
                codec,
                "-threads",
                "1",
                "-f",
                muxer,
            ]);
            if muxer == "image2pipe" {
                command.args(["-frames:v", "1"]);
            }
            command.arg(temp.path().join(name));
            run_bounded(&mut command, 1024).unwrap_or_else(|error| panic!("{name}: {error:#}"));
        }
        // F4V is an ISO base media container, unlike raw MPEG-4 in .m4v.
        std::fs::write(
            temp.path().join("clip.f4v"),
            include_bytes!("../frontend/scripts/fixtures/live-photo.mp4"),
        )
        .unwrap();
        for (name, _, _, container) in cases {
            let (_, _, video) =
                probe(&temp.path().join(name)).unwrap_or_else(|error| panic!("{name}: {error:#}"));
            assert_eq!(video.container, container, "{name}");
        }
        let index = crate::gallery::scan_gallery(temp.path(), None).unwrap();
        assert_eq!(index.images.len(), cases.len() + 1);
        for record in &index.images {
            assert!(record.video.is_some(), "{}", record.name);
            let poster =
                thumbnail(record, 32).unwrap_or_else(|error| panic!("{}: {error:#}", record.name));
            assert_eq!(poster.width().max(poster.height()), 32, "{}", record.name);
        }
    }

    #[test]
    #[ignore = "requires pic/video (or PIXHELF_FILESAMPLES_TESTSET), ffmpeg and ffprobe"]
    fn filesamples_video_testset() {
        let root = std::path::PathBuf::from(
            std::env::var("PIXHELF_FILESAMPLES_TESTSET").unwrap_or_else(|_| "pic/video".into()),
        );
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("filesamples-manifest.json")).unwrap(),
        )
        .unwrap();
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(
            files.len(),
            manifest["expected_files"].as_u64().unwrap() as usize
        );
        assert!(!files.is_empty());
        // These originals from FileSamples contain no video packets.
        let empty_swf = [
            "sample_1280x720_surfing_with_audio.swf",
            "sample_1920x800_ocean_with_audio.swf",
        ];
        let empty_rm = [
            "sample_1280x720.rm",
            "sample_2560x1440.rm",
            "sample_3840x2160.rm",
        ];
        let index = crate::gallery::scan_gallery(&root, None).unwrap();
        assert_eq!(index.images.len(), files.len() - empty_swf.len());
        let mut posters = 0;
        for file in files {
            let name = file["filename"].as_str().unwrap();
            assert!(
                mime_type(&root.join(name)).is_some(),
                "{name} is recognized"
            );
            let record = index.images.iter().find(|record| record.name == name);
            if empty_swf.contains(&name) {
                assert!(record.is_none(), "{name} has no video stream");
                continue;
            }
            let record = record.unwrap_or_else(|| panic!("{name} was not indexed"));
            assert!(record.video.is_some(), "{name}");
            let poster = thumbnail(record, 320);
            if empty_rm.contains(&name) {
                assert!(poster.is_err(), "{name} contains only headers");
            } else {
                let poster = poster.unwrap_or_else(|error| panic!("{name}: {error:#}"));
                assert!((1..=320).contains(&poster.width()), "{name}");
                assert!((1..=320).contains(&poster.height()), "{name}");
                posters += 1;
            }
        }
        assert_eq!(posters, files.len() - empty_swf.len() - empty_rm.len());
        eprintln!(
            "FileSamples: {} files checked, {posters} videos indexed with thumbnails, {} empty source files",
            files.len(),
            empty_swf.len() + empty_rm.len(),
        );
    }

    #[test]
    fn probe_uses_display_dimensions_and_skips_cover_art() {
        let value = json!({"streams": [
            {"index": 0, "codec_type": "video", "width": 100, "height": 100, "disposition": {"attached_pic": 1}},
            {"index": 1, "codec_type": "video", "codec_name": "h264", "width": 720, "height": 480,
                "sample_aspect_ratio": "4:3", "side_data_list": [{"rotation": -90}], "avg_frame_rate": "30000/1001"},
            {"index": 2, "codec_type": "audio", "codec_name": "aac"}
        ], "format": {"duration": "4.0", "format_name": "mov,mp4"}});
        let (width, height, metadata) = parse_probe(&value).unwrap();
        assert_eq!((width, height), (480, 960));
        assert_eq!(metadata.stream_index, 1);
        assert_eq!(metadata.audio_codec.as_deref(), Some("aac"));
        assert!((metadata.frame_rate.unwrap() - 29.97).abs() < 0.01);
    }

    #[test]
    fn unknown_duration_and_frame_rate_stay_unknown() {
        let value = json!({"streams": [{"index": 0, "codec_type": "video", "width": 640,
            "height": 360, "duration": "N/A", "avg_frame_rate": "0/0", "r_frame_rate": "0/0"}],
            "format": {"duration": "NaN"}});
        let (_, _, metadata) = parse_probe(&value).unwrap();
        assert!(metadata.duration.is_none());
        assert!(metadata.frame_rate.is_none());
        assert!(metadata.audio_codec.is_none());
        assert!(parse_probe(&json!({"streams": [{"codec_type": "audio"}]})).is_err());
    }
}
