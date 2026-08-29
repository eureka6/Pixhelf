use std::{env, ffi::OsString, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, anyhow, bail};

#[derive(Clone, Debug)]
pub struct Config {
    pub gallery_dir: PathBuf,
    pub cache_dir: PathBuf,
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
        Self::from_sources(cwd, env::args().skip(1), |name| env::var_os(name))
    }

    fn from_sources(
        cwd: PathBuf,
        args: impl IntoIterator<Item = String>,
        get_env: impl Fn(&str) -> Option<OsString>,
    ) -> Result<Self> {
        let args = args.into_iter().collect::<Vec<_>>();
        let is_overridden = |flag: &str| args.iter().any(|arg| arg == flag);
        let mut gallery_dir = if is_overridden("--gallery-dir") {
            cwd.join("pic")
        } else {
            env_path(&get_env, "PIXHELF_GALLERY_DIR", &cwd)?.unwrap_or_else(|| cwd.join("pic"))
        };
        let mut cache_dir = if is_overridden("--cache-dir") {
            cwd.join(".pixhelf-cache").join("thumbnails")
        } else {
            env_path(&get_env, "PIXHELF_CACHE_DIR", &cwd)?
                .unwrap_or_else(|| cwd.join(".pixhelf-cache").join("thumbnails"))
        };
        let mut text_search_model = if is_overridden("--text-search-model") {
            None
        } else {
            env_path(&get_env, "PIXHELF_TEXT_SEARCH_MODEL", &cwd)?
        };
        let mut text_search_vocabulary = if is_overridden("--text-search-vocab") {
            None
        } else {
            env_path(&get_env, "PIXHELF_TEXT_SEARCH_VOCAB", &cwd)?
        };
        let mut listen = match (!is_overridden("--listen"))
            .then(|| env_string(&get_env, "PIXHELF_LISTEN"))
            .transpose()?
            .flatten()
        {
            Some(raw) => raw
                .parse::<SocketAddr>()
                .with_context(|| "PIXHELF_LISTEN must be in HOST:PORT form")?,
            None => "0.0.0.0:3002".parse::<SocketAddr>()?,
        };
        let mut initial_batch = if is_overridden("--initial-batch") {
            60
        } else {
            env_number(&get_env, "PIXHELF_INITIAL_BATCH", 1, 500)?.unwrap_or(60)
        };
        let mut workers = if is_overridden("--workers") {
            default_worker_count()
        } else {
            env_number(&get_env, "PIXHELF_WORKERS", 1, 16)?.unwrap_or_else(default_worker_count)
        };
        let mut scan_interval = Duration::from_secs(if is_overridden("--scan-interval") {
            10
        } else {
            env_number(&get_env, "PIXHELF_SCAN_INTERVAL", 2, 3600)?.unwrap_or(10)
        } as u64);

        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--gallery-dir" => gallery_dir = path_value(&mut args, &arg, &cwd)?,
                "--cache-dir" => cache_dir = path_value(&mut args, &arg, &cwd)?,
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

fn env_value(get_env: &impl Fn(&str) -> Option<OsString>, name: &str) -> Result<Option<OsString>> {
    let Some(value) = get_env(name) else {
        return Ok(None);
    };
    if value.is_empty() {
        bail!("{name} cannot be empty");
    }
    Ok(Some(value))
}

fn env_string(get_env: &impl Fn(&str) -> Option<OsString>, name: &str) -> Result<Option<String>> {
    env_value(get_env, name)?
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow!("{name} must be valid UTF-8"))
        })
        .transpose()
}

fn env_path(
    get_env: &impl Fn(&str) -> Option<OsString>,
    name: &str,
    cwd: &std::path::Path,
) -> Result<Option<PathBuf>> {
    Ok(env_value(get_env, name)?.map(|value| resolve_path(PathBuf::from(value), cwd)))
}

fn env_number(
    get_env: &impl Fn(&str) -> Option<OsString>,
    name: &str,
    min: usize,
    max: usize,
) -> Result<Option<usize>> {
    env_string(get_env, name)?
        .map(|raw| parse_number(&raw, name, min, max))
        .transpose()
}

fn path_value(
    args: &mut impl Iterator<Item = String>,
    flag: &str,
    cwd: &std::path::Path,
) -> Result<PathBuf> {
    Ok(resolve_path(PathBuf::from(value(args, flag)?), cwd))
}

fn resolve_path(path: PathBuf, cwd: &std::path::Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn number_value(
    args: &mut impl Iterator<Item = String>,
    flag: &str,
    min: usize,
    max: usize,
) -> Result<usize> {
    let raw = value(args, flag)?;
    parse_number(&raw, flag, min, max)
}

fn parse_number(raw: &str, label: &str, min: usize, max: usize) -> Result<usize> {
    let parsed = raw
        .parse::<usize>()
        .with_context(|| format!("{label} must be a number"))?;
    if !(min..=max).contains(&parsed) {
        bail!("{label} must be between {min} and {max}");
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
  --text-search-model PATH  Optional OFA Chinese-CLIP ViT-B/16 safetensors model\n  \
  --text-search-vocab PATH  Chinese-CLIP vocab.txt (default: beside model)\n  \
  --listen HOST:PORT     Listen address (default: 0.0.0.0:3002)\n  \
  --initial-batch N      Priority thumbnail batch (default: 60)\n  \
  --workers N            Background thumbnail workers (default: 2-4, based on CPU)\n  \
  --scan-interval SEC    Gallery rescan interval (default: 10)\n  \
  -h, --help             Show this help\n\n\
Environment:\n  \
  PIXHELF_GALLERY_DIR, PIXHELF_CACHE_DIR, PIXHELF_TEXT_SEARCH_MODEL,\n  \
  PIXHELF_TEXT_SEARCH_VOCAB, PIXHELF_LISTEN,\n  \
  PIXHELF_INITIAL_BATCH, PIXHELF_WORKERS, PIXHELF_SCAN_INTERVAL\n\n\
Command-line options override matching environment variables."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn validates_numeric_ranges() {
        let mut valid = ["4".to_owned()].into_iter();
        assert_eq!(number_value(&mut valid, "--workers", 1, 16).unwrap(), 4);

        let mut invalid = ["0".to_owned()].into_iter();
        assert!(number_value(&mut invalid, "--workers", 1, 16).is_err());
    }

    #[test]
    fn reads_environment_and_allows_arguments_to_override_it() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        let cache = temp.path().join("cache");
        std::fs::create_dir(&gallery).unwrap();

        let environment = HashMap::from([
            ("PIXHELF_GALLERY_DIR", gallery.as_os_str().to_os_string()),
            ("PIXHELF_CACHE_DIR", cache.as_os_str().to_os_string()),
            ("PIXHELF_LISTEN", OsString::from("127.0.0.1:4000")),
            ("PIXHELF_INITIAL_BATCH", OsString::from("90")),
            ("PIXHELF_WORKERS", OsString::from("invalid")),
            ("PIXHELF_SCAN_INTERVAL", OsString::from("20")),
        ]);
        let args = ["--workers", "7", "--scan-interval", "45"].map(str::to_owned);

        let config = Config::from_sources(temp.path().to_path_buf(), args, |name| {
            environment.get(name).cloned()
        })
        .unwrap();

        assert_eq!(config.gallery_dir, gallery.canonicalize().unwrap());
        assert_eq!(config.cache_dir, cache.canonicalize().unwrap());
        assert_eq!(config.listen, "127.0.0.1:4000".parse().unwrap());
        assert_eq!(config.initial_batch, 90);
        assert_eq!(config.workers, 7);
        assert_eq!(config.scan_interval, Duration::from_secs(45));
    }

    #[test]
    fn reports_invalid_environment_values_by_name() {
        let error = env_number(
            &|name| (name == "PIXHELF_WORKERS").then(|| OsString::from("99")),
            "PIXHELF_WORKERS",
            1,
            16,
        )
        .unwrap_err();

        assert!(error.to_string().contains("PIXHELF_WORKERS"));
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
