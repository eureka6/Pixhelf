use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};

#[derive(Clone, Debug)]
pub struct Config {
    pub gallery_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub semantic_model: Option<PathBuf>,
    pub text_search: Option<TextSearchFiles>,
    pub listen: SocketAddr,
    pub initial_batch: usize,
    pub workers: usize,
    pub scan_interval: Duration,
}

#[derive(Clone, Debug)]
pub struct TextSearchFiles {
    pub model: PathBuf,
    pub vocabulary: PathBuf,
}

impl Config {
    pub fn from_env_and_args() -> Result<Self> {
        let cwd = env::current_dir().context("cannot determine the working directory")?;
        let mut gallery_dir = cwd.join("pic");
        let mut cache_dir = cwd.join(".pixhelf-cache").join("thumbnails");
        let mut semantic_model = None;
        let mut text_search_model = None;
        let mut text_search_vocabulary = None;
        let mut listen = "0.0.0.0:3002".parse::<SocketAddr>()?;
        let mut initial_batch = 60usize;
        let mut workers = default_worker_count();
        let mut scan_interval = Duration::from_secs(10);

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--gallery-dir" => gallery_dir = path_value(&mut args, &arg, &cwd)?,
                "--cache-dir" => cache_dir = path_value(&mut args, &arg, &cwd)?,
                "--semantic-model" => {
                    semantic_model = Some(path_value(&mut args, &arg, &cwd)?);
                }
                "--text-search-model" => {
                    text_search_model = Some(path_value(&mut args, &arg, &cwd)?);
                }
                "--text-search-vocab" => {
                    text_search_vocabulary = Some(path_value(&mut args, &arg, &cwd)?);
                }
                "--listen" => {
                    listen = value(&mut args, &arg)?
                        .parse()
                        .with_context(|| "--listen must be in HOST:PORT form")?;
                }
                "--initial-batch" => {
                    initial_batch = number_value(&mut args, &arg, 1, 500)?;
                }
                "--workers" => workers = number_value(&mut args, &arg, 1, 16)?,
                "--scan-interval" => {
                    scan_interval =
                        Duration::from_secs(number_value(&mut args, &arg, 2, 3600)? as u64);
                }
                "-h" | "--help" => {
                    print_help();
                    std::process::exit(0);
                }
                unknown => bail!("unknown argument: {unknown}\n\nRun pixhelf --help for usage."),
            }
        }

        gallery_dir = canonical_directory(&gallery_dir, "gallery")?;
        std::fs::create_dir_all(&cache_dir)
            .with_context(|| format!("cannot create cache directory: {}", cache_dir.display()))?;
        cache_dir = canonical_directory(&cache_dir, "cache")?;
        ensure_cache_is_external(&gallery_dir, &cache_dir)?;
        semantic_model = semantic_model
            .map(|path| canonical_file(&path, "semantic model"))
            .transpose()?;
        let text_search = match text_search_model {
            Some(model) => {
                let model = canonical_file(&model, "text-search model")?;
                let vocabulary = text_search_vocabulary
                    .unwrap_or_else(|| model.parent().unwrap_or(&cwd).join("vocab.txt"));
                let vocabulary = canonical_file(&vocabulary, "text-search vocabulary")?;
                Some(TextSearchFiles { model, vocabulary })
            }
            None if text_search_vocabulary.is_some() => {
                bail!("--text-search-vocab requires --text-search-model");
            }
            None => None,
        };

        Ok(Self {
            gallery_dir,
            cache_dir,
            semantic_model,
            text_search,
            listen,
            initial_batch,
            workers,
            scan_interval,
        })
    }
}

fn canonical_directory(path: &std::path::Path, label: &str) -> Result<PathBuf> {
    if !path.is_dir() {
        bail!("{label} directory does not exist: {}", path.display());
    }
    std::fs::canonicalize(path)
        .with_context(|| format!("cannot resolve {label} directory: {}", path.display()))
}

fn canonical_file(path: &std::path::Path, label: &str) -> Result<PathBuf> {
    if !path.is_file() {
        bail!("{label} file does not exist: {}", path.display());
    }
    std::fs::canonicalize(path)
        .with_context(|| format!("cannot resolve {label} file: {}", path.display()))
}

fn ensure_cache_is_external(
    gallery_dir: &std::path::Path,
    cache_dir: &std::path::Path,
) -> Result<()> {
    if cache_dir.starts_with(gallery_dir) {
        bail!(
            "cache directory must be outside the gallery directory: {}",
            cache_dir.display()
        );
    }
    Ok(())
}

fn value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next()
        .with_context(|| format!("{flag} requires a value"))
}

fn path_value(
    args: &mut impl Iterator<Item = String>,
    flag: &str,
    cwd: &std::path::Path,
) -> Result<PathBuf> {
    let path = PathBuf::from(value(args, flag)?);
    Ok(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

fn number_value(
    args: &mut impl Iterator<Item = String>,
    flag: &str,
    min: usize,
    max: usize,
) -> Result<usize> {
    let raw = value(args, flag)?;
    let parsed = raw
        .parse::<usize>()
        .with_context(|| format!("{flag} must be a number"))?;
    if !(min..=max).contains(&parsed) {
        bail!("{flag} must be between {min} and {max}");
    }
    Ok(parsed)
}

fn default_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(2, 4))
        .unwrap_or(2)
}

fn print_help() {
    println!(
        "pixhelf - a self-hosted image gallery\n\n\
Usage: pixhelf [OPTIONS]\n\n\
Options:\n  \
  --gallery-dir PATH     Gallery root (default: ./pic)\n  \
  --cache-dir PATH       Thumbnail cache (default: ./.pixhelf-cache/thumbnails)\n  \
  --semantic-model PATH  Optional official facebook/dinov2-small safetensors model\n  \
  --text-search-model PATH  Optional OFA Chinese-CLIP ViT-B/16 safetensors model\n  \
  --text-search-vocab PATH  Chinese-CLIP vocab.txt (default: beside model)\n  \
  --listen HOST:PORT     Listen address (default: 0.0.0.0:3002)\n  \
  --initial-batch N      Priority thumbnail batch (default: 60)\n  \
  --workers N            Background thumbnail workers (default: 2-4, based on CPU)\n  \
  --scan-interval SEC    Gallery rescan interval (default: 10)\n  \
  -h, --help             Show this help"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_numeric_ranges() {
        let mut valid = ["4".to_owned()].into_iter();
        assert_eq!(number_value(&mut valid, "--workers", 1, 16).unwrap(), 4);

        let mut invalid = ["0".to_owned()].into_iter();
        assert!(number_value(&mut invalid, "--workers", 1, 16).is_err());
    }

    #[test]
    fn resolves_existing_directories() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            canonical_directory(temp.path(), "test").unwrap(),
            temp.path().canonicalize().unwrap()
        );
        assert!(canonical_directory(&temp.path().join("missing"), "test").is_err());
    }

    #[test]
    fn resolves_only_existing_model_files() {
        let temp = tempfile::tempdir().unwrap();
        let model = temp.path().join("model.safetensors");
        std::fs::write(&model, b"model").unwrap();

        assert_eq!(
            canonical_file(&model, "model").unwrap(),
            model.canonicalize().unwrap()
        );
        assert!(canonical_file(temp.path(), "model").is_err());
        assert!(canonical_file(&temp.path().join("missing"), "model").is_err());
    }

    #[test]
    fn rejects_cache_directories_inside_the_gallery() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        let nested_cache = gallery.join("cache");
        let external_cache = temp.path().join("cache");

        assert!(ensure_cache_is_external(&gallery, &nested_cache).is_err());
        assert!(ensure_cache_is_external(&gallery, &external_cache).is_ok());
    }
}
