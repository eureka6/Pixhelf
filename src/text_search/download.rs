use std::{
    ffi::OsString,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use reqwest::{Client, StatusCode, header::RANGE};
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncWriteExt};
use tracing::{info, warn};

use crate::config::TextSearchFiles;

const MODEL_REVISION: &str = "f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e";
const MODEL_BASE_URL: &str = "https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve";
const PROGRESS_INTERVAL: u64 = 64 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS: usize = 5;

const ARTIFACTS: [Artifact; 2] = [
    Artifact {
        kind: ArtifactKind::Model,
        filename: "model.safetensors",
        sha256: "29cc0b2bcf6ff777f2e15742be92b110e4acbdb2068356e862c4637a4b15fe4f",
        size: 753_106_020,
    },
    Artifact {
        kind: ArtifactKind::Vocabulary,
        filename: "vocab.txt",
        sha256: "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c",
        size: 109_540,
    },
];

#[derive(Clone, Copy)]
struct Artifact {
    kind: ArtifactKind,
    filename: &'static str,
    sha256: &'static str,
    size: u64,
}

#[derive(Clone, Copy)]
enum ArtifactKind {
    Model,
    Vocabulary,
}

impl Artifact {
    fn destination<'a>(&self, files: &'a TextSearchFiles) -> &'a Path {
        match self.kind {
            ArtifactKind::Model => &files.model,
            ArtifactKind::Vocabulary => &files.vocabulary,
        }
    }

    fn url(&self) -> String {
        format!("{MODEL_BASE_URL}/{MODEL_REVISION}/{}", self.filename)
    }
}

pub(crate) async fn ensure_automatic_model(files: &TextSearchFiles) -> Result<()> {
    let mut missing = Vec::new();
    for artifact in ARTIFACTS {
        let destination = artifact.destination(files);
        if cached_artifact_is_valid(destination, artifact).await? {
            info!(file = %destination.display(), "using cached model file");
        } else {
            missing.push(artifact);
        }
    }

    if missing.is_empty() {
        return Ok(());
    }

    for destination in [&files.model, &files.vocabulary] {
        let parent = destination.parent().with_context(|| {
            format!("model cache path has no parent: {}", destination.display())
        })?;
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("cannot create model cache: {}", parent.display()))?;
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent(concat!("pixhelf/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("cannot initialise the model downloader")?;
    for artifact in missing {
        let url = artifact.url();
        download_artifact(&client, artifact.destination(files), artifact, &url).await?;
    }

    info!(
        directory = %files.model.parent().unwrap_or(&files.model).display(),
        "natural-language search model downloaded"
    );
    Ok(())
}

async fn download_artifact(
    client: &Client,
    destination: &Path,
    artifact: Artifact,
    url: &str,
) -> Result<()> {
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        let result = download_artifact_once(client, destination, artifact, url).await;
        if result.is_ok() || attempt == DOWNLOAD_ATTEMPTS {
            return result.with_context(|| {
                format!(
                    "failed to download {} after {attempt} attempts",
                    artifact.filename
                )
            });
        }

        let error = result.expect_err("failed download must contain an error");
        let retry_seconds = 1_u64 << (attempt - 1);
        warn!(
            file = artifact.filename,
            attempt,
            retry_seconds,
            error = %format!("{error:#}"),
            "model download failed; retrying"
        );
        tokio::time::sleep(Duration::from_secs(retry_seconds)).await;
    }
    unreachable!("download attempt loop always returns")
}

async fn download_artifact_once(
    client: &Client,
    destination: &Path,
    artifact: Artifact,
    url: &str,
) -> Result<()> {
    let partial = suffixed_path(destination, ".part");
    let mut downloaded = file_size_or_zero(&partial).await?;

    if downloaded == artifact.size {
        if sha256_file(partial.clone()).await? == artifact.sha256 {
            install_artifact(&partial, destination, artifact.sha256).await?;
            return Ok(());
        }
        fs::remove_file(&partial)
            .await
            .with_context(|| format!("cannot remove invalid download: {}", partial.display()))?;
        downloaded = 0;
    } else if downloaded > artifact.size {
        fs::remove_file(&partial)
            .await
            .with_context(|| format!("cannot remove invalid download: {}", partial.display()))?;
        downloaded = 0;
    }

    let resumed_from = downloaded;
    let mut request = client.get(url);
    if resumed_from > 0 {
        request = request.header(RANGE, format!("bytes={resumed_from}-"));
    }

    info!(
        file = artifact.filename,
        downloaded_bytes = resumed_from,
        total_bytes = artifact.size,
        "downloading natural-language search model"
    );
    let mut response = request
        .send()
        .await
        .with_context(|| format!("cannot download {url}"))?;
    if resumed_from > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
        info!(
            file = artifact.filename,
            "download source does not support this range request; restarting the file"
        );
        response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("cannot restart download {url}"))?;
    }
    let status = response.status();
    if !status.is_success() {
        bail!("model download returned HTTP {status}: {url}");
    }

    let resuming = resumed_from > 0 && status == StatusCode::PARTIAL_CONTENT;
    if !resuming {
        downloaded = 0;
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true);
    if resuming {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut output = options
        .open(&partial)
        .await
        .with_context(|| format!("cannot open model download: {}", partial.display()))?;
    let mut next_progress = downloaded.saturating_add(PROGRESS_INTERVAL);

    while let Some(chunk) = response
        .chunk()
        .await
        .with_context(|| format!("model download interrupted: {}", artifact.filename))?
    {
        output
            .write_all(&chunk)
            .await
            .with_context(|| format!("cannot write model download: {}", partial.display()))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > artifact.size {
            bail!(
                "downloaded {} is larger than expected ({} > {} bytes)",
                artifact.filename,
                downloaded,
                artifact.size
            );
        }
        if downloaded >= next_progress || downloaded == artifact.size {
            info!(
                file = artifact.filename,
                percent = downloaded.saturating_mul(100) / artifact.size,
                downloaded_bytes = downloaded,
                total_bytes = artifact.size,
                "model download progress"
            );
            next_progress = downloaded.saturating_add(PROGRESS_INTERVAL);
        }
    }
    output
        .sync_all()
        .await
        .with_context(|| format!("cannot save model download: {}", partial.display()))?;
    drop(output);

    if downloaded != artifact.size {
        bail!(
            "downloaded {} has the wrong size ({} of {} bytes); restart Pixhelf to resume",
            artifact.filename,
            downloaded,
            artifact.size
        );
    }

    let checksum = sha256_file(partial.clone()).await?;
    if checksum != artifact.sha256 {
        fs::remove_file(&partial).await.with_context(|| {
            format!(
                "cannot remove checksum-mismatched file: {}",
                partial.display()
            )
        })?;
        bail!(
            "downloaded {} failed SHA-256 verification",
            artifact.filename
        );
    }

    install_artifact(&partial, destination, artifact.sha256).await
}

async fn cached_artifact_is_valid(path: &Path, artifact: Artifact) -> Result<bool> {
    let metadata = match fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("cannot inspect cached model: {}", path.display()));
        }
    };
    if !metadata.is_file() || metadata.len() != artifact.size {
        return Ok(false);
    }

    let marker = checksum_marker(path);
    if let Ok(recorded) = fs::read_to_string(&marker).await
        && recorded.trim() == artifact.sha256
        && marker_is_current(&marker, &metadata).await
    {
        return Ok(true);
    }

    if sha256_file(path.to_path_buf()).await? != artifact.sha256 {
        return Ok(false);
    }
    write_checksum_marker(path, artifact.sha256).await?;
    Ok(true)
}

async fn marker_is_current(marker: &Path, artifact: &std::fs::Metadata) -> bool {
    let Ok(marker) = fs::metadata(marker).await else {
        return false;
    };
    match (marker.modified(), artifact.modified()) {
        (Ok(marker_time), Ok(artifact_time)) => marker_time >= artifact_time,
        _ => true,
    }
}

async fn file_size_or_zero(path: &Path) -> Result<u64> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => bail!("model download path is not a file: {}", path.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(0),
        Err(error) => {
            Err(error).with_context(|| format!("cannot inspect download: {}", path.display()))
        }
    }
}

async fn sha256_file(path: PathBuf) -> Result<String> {
    let display = path.display().to_string();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .with_context(|| format!("cannot open file for verification: {display}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .with_context(|| format!("cannot verify file: {display}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .context("model verification task stopped")?
}

async fn install_artifact(partial: &Path, destination: &Path, checksum: &str) -> Result<()> {
    if fs::try_exists(destination).await.with_context(|| {
        format!(
            "cannot inspect model destination: {}",
            destination.display()
        )
    })? {
        fs::remove_file(destination)
            .await
            .with_context(|| format!("cannot replace cached model: {}", destination.display()))?;
    }
    fs::rename(partial, destination).await.with_context(|| {
        format!(
            "cannot install downloaded model: {} -> {}",
            partial.display(),
            destination.display()
        )
    })?;
    write_checksum_marker(destination, checksum).await
}

async fn write_checksum_marker(path: &Path, checksum: &str) -> Result<()> {
    let marker = checksum_marker(path);
    let temporary = suffixed_path(&marker, ".tmp");
    fs::write(&temporary, format!("{checksum}\n"))
        .await
        .with_context(|| format!("cannot write model checksum: {}", temporary.display()))?;
    if fs::try_exists(&marker)
        .await
        .with_context(|| format!("cannot inspect model checksum: {}", marker.display()))?
    {
        fs::remove_file(&marker)
            .await
            .with_context(|| format!("cannot replace model checksum: {}", marker.display()))?;
    }
    fs::rename(&temporary, &marker)
        .await
        .with_context(|| format!("cannot save model checksum: {}", marker.display()))
}

fn checksum_marker(path: &Path) -> PathBuf {
    suffixed_path(path, ".sha256")
}

fn suffixed_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_ARTIFACT: Artifact = Artifact {
        kind: ArtifactKind::Model,
        filename: "model.safetensors",
        sha256: "9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4",
        size: 5,
    };

    #[tokio::test]
    async fn verifies_and_marks_an_existing_cached_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(TEST_ARTIFACT.filename);
        fs::write(&path, b"model").await.unwrap();

        assert!(
            cached_artifact_is_valid(&path, TEST_ARTIFACT)
                .await
                .unwrap()
        );
        assert_eq!(
            fs::read_to_string(checksum_marker(&path))
                .await
                .unwrap()
                .trim(),
            TEST_ARTIFACT.sha256
        );
    }

    #[tokio::test]
    async fn rejects_same_sized_corrupt_cached_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(TEST_ARTIFACT.filename);
        fs::write(&path, b"wrong").await.unwrap();

        assert!(
            !cached_artifact_is_valid(&path, TEST_ARTIFACT)
                .await
                .unwrap()
        );
        assert!(!checksum_marker(&path).exists());
    }

    #[tokio::test]
    #[ignore = "requires access to the official model repository"]
    async fn downloads_and_verifies_the_official_vocabulary() {
        let temp = tempfile::tempdir().unwrap();
        let artifact = ARTIFACTS[1];
        let path = temp.path().join(artifact.filename);
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap();

        let url = artifact.url();
        download_artifact(&client, &path, artifact, &url)
            .await
            .unwrap();

        assert!(cached_artifact_is_valid(&path, artifact).await.unwrap());

        let content = fs::read(&path).await.unwrap();
        fs::remove_file(&path).await.unwrap();
        fs::remove_file(checksum_marker(&path)).await.unwrap();
        fs::write(suffixed_path(&path, ".part"), &content[..content.len() / 2])
            .await
            .unwrap();

        download_artifact(&client, &path, artifact, &url)
            .await
            .unwrap();
        assert_eq!(fs::read(&path).await.unwrap(), content);
    }

    #[tokio::test]
    #[ignore = "downloads and loads the complete 753 MB Hugging Face checkpoint"]
    async fn downloads_and_loads_the_complete_huggingface_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let files = TextSearchFiles {
            model: temp.path().join(ARTIFACTS[0].filename),
            vocabulary: temp.path().join(ARTIFACTS[1].filename),
        };

        ensure_automatic_model(&files).await.unwrap();

        let model = files.model.clone();
        let vocabulary = files.vocabulary.clone();
        tokio::task::spawn_blocking(move || {
            crate::text_search::model::validate_checkpoint(&model, &vocabulary)
        })
        .await
        .unwrap()
        .unwrap();
    }

    #[test]
    fn uses_the_pinned_huggingface_checkpoint() {
        let artifact = ARTIFACTS[0];
        let url = artifact.url();
        assert!(url.starts_with("https://huggingface.co/OFA-Sys/"));
        assert!(url.contains(MODEL_REVISION));
        assert!(url.ends_with("/model.safetensors"));
    }
}
