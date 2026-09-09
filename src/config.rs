use std::{
    env,
    ffi::{OsStr, OsString},
    net::SocketAddr,
    path::PathBuf,
    time::Duration,
};

use crate::auth::AuthConfig;
use anyhow::{Context, Result, anyhow, bail};

#[derive(Clone, Debug)]
pub struct Config {
    pub gallery_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub text_search: Option<TextSearchSource>,
    pub listen: SocketAddr,
    pub initial_batch: usize,
    pub workers: usize,
    pub scan_interval: Duration,
    pub auth: AuthConfig,
}

#[derive(Clone, Debug)]
pub struct TextSearchFiles {
    pub model: PathBuf,
    pub vocabulary: PathBuf,
}

#[derive(Clone, Debug)]
pub enum TextSearchSource {
    Local(TextSearchFiles),
    AutoDownload(TextSearchFiles),
}

#[derive(Clone, Debug)]
enum TextSearchModelInput {
    Local(PathBuf),
    AutoDownload,
    Disabled,
}

const TEXT_SEARCH_MODEL_FILENAME: &str = "model.safetensors";
const TEXT_SEARCH_VOCABULARY_FILENAME: &str = "vocab.txt";
const TEXT_SEARCH_ENABLED_VALUE: &str = "true";
const TEXT_SEARCH_DISABLED_VALUE: &str = "false";
const TEXT_SEARCH_LEGACY_AUTO_VALUE: &str = "auto";
const TEXT_SEARCH_AUTO_CACHE_DIRECTORY: &str = "models/chinese-clip-vit-base-patch16-f4a64596";

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
        let configured_cache = if is_overridden("--cache-dir") {
            None
        } else {
            env_path(&get_env, "PIXHELF_CACHE_DIR", &cwd)?
        };
        let using_default_cache = configured_cache.is_none() && !is_overridden("--cache-dir");
        let mut cache_dir =
            configured_cache.unwrap_or_else(|| cwd.join(".pixhelf-data").join("thumbnails"));
        let mut text_search_model = if is_overridden("--text-search-model") {
            None
        } else {
            env_text_search_model(&get_env, &cwd)?.or(Some(TextSearchModelInput::AutoDownload))
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
                    text_search_model = Some(text_search_model_value(&mut args, &arg, &cwd)?);
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
                unknown => bail!("unknown argument: {unknown}; run pixhelf --help for usage"),
            }
        }

        gallery_dir = canonical_directory(&gallery_dir, "gallery")?;
        if using_default_cache && !cache_dir.try_exists()? {
            let legacy = cwd.join(".pixhelf-cache");
            if legacy.try_exists()? {
                bail!(
                    "legacy data found at {}; stop Pixhelf and rename it to {}, or use --cache-dir {} to keep the existing data directory",
                    legacy.display(),
                    cwd.join(".pixhelf-data").display(),
                    legacy.join("thumbnails").display(),
                );
            }
        }
        std::fs::create_dir_all(&cache_dir)
            .with_context(|| format!("cannot create cache directory: {}", cache_dir.display()))?;
        cache_dir = canonical_directory(&cache_dir, "cache")?;
        ensure_cache_is_external(&gallery_dir, &cache_dir)?;
        let text_search = match text_search_model {
            Some(TextSearchModelInput::Local(model)) => Some(TextSearchSource::Local(
                resolve_text_search_files(&model, text_search_vocabulary.as_deref(), &cwd)?,
            )),
            Some(TextSearchModelInput::AutoDownload) if text_search_vocabulary.is_some() => {
                bail!("text-search vocabulary cannot be used with automatic model download");
            }
            Some(TextSearchModelInput::AutoDownload) => {
                let directory = cache_dir.join(TEXT_SEARCH_AUTO_CACHE_DIRECTORY);
                Some(TextSearchSource::AutoDownload(TextSearchFiles {
                    model: directory.join(TEXT_SEARCH_MODEL_FILENAME),
                    vocabulary: directory.join(TEXT_SEARCH_VOCABULARY_FILENAME),
                }))
            }
            Some(TextSearchModelInput::Disabled) if text_search_vocabulary.is_some() => {
                bail!("text-search vocabulary requires text search to be enabled");
            }
            Some(TextSearchModelInput::Disabled) => None,
            None if text_search_vocabulary.is_some() => {
                bail!("--text-search-vocab requires --text-search-model");
            }
            None => None,
        };

        Ok(Self {
            auth: AuthConfig::from_sources(&cwd, &cache_dir, &get_env)?,
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

fn resolve_text_search_files(
    model_or_directory: &std::path::Path,
    vocabulary: Option<&std::path::Path>,
    cwd: &std::path::Path,
) -> Result<TextSearchFiles> {
    let model = if model_or_directory.is_dir() {
        model_or_directory.join(TEXT_SEARCH_MODEL_FILENAME)
    } else {
        model_or_directory.to_path_buf()
    };
    let model = canonical_file(&model, "text-search model")?;
    let vocabulary = vocabulary.map_or_else(
        || {
            model
                .parent()
                .unwrap_or(cwd)
                .join(TEXT_SEARCH_VOCABULARY_FILENAME)
        },
        std::path::Path::to_path_buf,
    );
    let vocabulary = canonical_file(&vocabulary, "text-search vocabulary")?;

    Ok(TextSearchFiles { model, vocabulary })
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

fn env_text_search_model(
    get_env: &impl Fn(&str) -> Option<OsString>,
    cwd: &std::path::Path,
) -> Result<Option<TextSearchModelInput>> {
    Ok(env_value(get_env, "PIXHELF_TEXT_SEARCH_MODEL")?
        .map(|value| parse_text_search_model(value, cwd)))
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

fn text_search_model_value(
    args: &mut impl Iterator<Item = String>,
    flag: &str,
    cwd: &std::path::Path,
) -> Result<TextSearchModelInput> {
    Ok(parse_text_search_model(
        OsString::from(value(args, flag)?),
        cwd,
    ))
}

fn parse_text_search_model(value: OsString, cwd: &std::path::Path) -> TextSearchModelInput {
    if value == OsStr::new(TEXT_SEARCH_ENABLED_VALUE)
        || value == OsStr::new(TEXT_SEARCH_LEGACY_AUTO_VALUE)
    {
        TextSearchModelInput::AutoDownload
    } else if value == OsStr::new(TEXT_SEARCH_DISABLED_VALUE) {
        TextSearchModelInput::Disabled
    } else {
        TextSearchModelInput::Local(resolve_path(PathBuf::from(value), cwd))
    }
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
  --cache-dir PATH       Application data (default: ./.pixhelf-data/thumbnails)\n  \
  --text-search-model VALUE 'true', 'false', Chinese-CLIP directory, or model file (default: true)\n  \
  --text-search-vocab PATH  Optional vocab.txt override (default: beside model)\n  \
  --listen HOST:PORT     Listen address (default: 0.0.0.0:3002)\n  \
  --initial-batch N      Priority thumbnail batch (default: 60)\n  \
  --workers N            Background thumbnail workers (default: 2-4, based on CPU)\n  \
  --scan-interval SEC    Gallery rescan interval (default: 10)\n  \
  --hash-password       Generate an Argon2id hash (hidden prompt or stdin)\n  \
  -h, --help             Show this help\n\n\
Environment:\n  \
  PIXHELF_GALLERY_DIR, PIXHELF_CACHE_DIR, PIXHELF_TEXT_SEARCH_MODEL,\n  \
  PIXHELF_TEXT_SEARCH_VOCAB, PIXHELF_LISTEN,\n  \
  PIXHELF_INITIAL_BATCH, PIXHELF_WORKERS, PIXHELF_SCAN_INTERVAL,\n  \
  PIXHELF_AUTH_ENABLED (default: true), PIXHELF_AUTH_USERNAME (default: admin),\n  \
  PIXHELF_AUTH_PASSWORD_HASH, PIXHELF_AUTH_PASSWORD_HASH_FILE,\n  \
  PIXHELF_PUBLIC_URL (optional HTTP/HTTPS origin override), PIXHELF_TRUSTED_PROXIES (CIDRs)\n\n\
Without password environment variables, create the administrator in the web setup page.\n\
Setup and login support HTTP and HTTPS. Settings persist in CACHE_DIR/auth/.\n\n\
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
            ("PIXHELF_AUTH_ENABLED", OsString::from("false")),
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
    fn default_data_directory_keeps_settings_and_models_under_pixhelf_data() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("pic")).unwrap();
        let config = Config::from_sources(temp.path().to_path_buf(), [], |_| None).unwrap();
        let expected = temp
            .path()
            .join(".pixhelf-data/thumbnails")
            .canonicalize()
            .unwrap();
        assert_eq!(config.cache_dir, expected);
        assert_eq!(
            config.auth.setup.unwrap().path,
            expected.join("auth/account.json")
        );
        assert!(!temp.path().join(".pixhelf-cache").exists());
        let Some(TextSearchSource::AutoDownload(files)) = config.text_search else {
            panic!("expected automatic model download");
        };
        assert!(files.model.starts_with(expected));
    }

    #[test]
    fn legacy_data_requires_migration_or_an_explicit_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("pic")).unwrap();
        let legacy = temp.path().join(".pixhelf-cache/thumbnails");
        std::fs::create_dir_all(legacy.join("auth")).unwrap();
        let account = legacy.join("auth/account.json");
        std::fs::write(&account, b"existing account").unwrap();
        let error = Config::from_sources(temp.path().to_path_buf(), [], |_| None).unwrap_err();
        assert!(error.to_string().contains("legacy data found"));
        assert!(!temp.path().join(".pixhelf-data").exists());
        assert_eq!(std::fs::read(&account).unwrap(), b"existing account");

        for via_cli in [false, true] {
            let args = if via_cli {
                vec![
                    "--cache-dir".to_owned(),
                    legacy.to_string_lossy().into_owned(),
                ]
            } else {
                Vec::new()
            };
            let config = Config::from_sources(temp.path().to_path_buf(), args, |name| match name {
                "PIXHELF_AUTH_ENABLED" => Some(OsString::from("false")),
                "PIXHELF_CACHE_DIR" if !via_cli => Some(legacy.as_os_str().to_owned()),
                _ => None,
            })
            .unwrap();
            assert_eq!(config.cache_dir, legacy.canonicalize().unwrap());
        }
        std::fs::rename(
            temp.path().join(".pixhelf-cache"),
            temp.path().join(".pixhelf-data"),
        )
        .unwrap();
        let config = Config::from_sources(temp.path().to_path_buf(), [], |name| {
            (name == "PIXHELF_AUTH_ENABLED").then(|| OsString::from("false"))
        })
        .unwrap();
        assert_eq!(
            std::fs::read(config.cache_dir.join("auth/account.json")).unwrap(),
            b"existing account"
        );
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
        let model = temp.path().join(TEXT_SEARCH_MODEL_FILENAME);
        std::fs::write(&model, b"model").unwrap();

        assert_eq!(
            canonical_file(&model, "model").unwrap(),
            model.canonicalize().unwrap()
        );
        assert!(canonical_file(temp.path(), "model").is_err());
        assert!(canonical_file(&temp.path().join("missing"), "model").is_err());
    }

    #[test]
    fn resolves_text_search_directory_and_legacy_file_path() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("chinese-clip");
        std::fs::create_dir(&directory).unwrap();
        let model = directory.join(TEXT_SEARCH_MODEL_FILENAME);
        let vocabulary = directory.join(TEXT_SEARCH_VOCABULARY_FILENAME);
        std::fs::write(&model, b"model").unwrap();
        std::fs::write(&vocabulary, b"vocabulary").unwrap();

        let from_directory = resolve_text_search_files(&directory, None, temp.path()).unwrap();
        let from_file = resolve_text_search_files(&model, None, temp.path()).unwrap();

        assert_eq!(from_directory.model, model.canonicalize().unwrap());
        assert_eq!(
            from_directory.vocabulary,
            vocabulary.canonicalize().unwrap()
        );
        assert_eq!(from_file.model, from_directory.model);
        assert_eq!(from_file.vocabulary, from_directory.vocabulary);
    }

    #[test]
    fn semantic_search_is_enabled_by_default_and_uses_the_persistent_cache() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        let cache = temp.path().join("cache");
        std::fs::create_dir(&gallery).unwrap();
        let environment = HashMap::from([
            ("PIXHELF_AUTH_ENABLED", OsString::from("false")),
            ("PIXHELF_GALLERY_DIR", gallery.as_os_str().to_os_string()),
            ("PIXHELF_CACHE_DIR", cache.as_os_str().to_os_string()),
        ]);

        let config = Config::from_sources(temp.path().to_path_buf(), [], |name| {
            environment.get(name).cloned()
        })
        .unwrap();
        let expected = config.cache_dir.join(TEXT_SEARCH_AUTO_CACHE_DIRECTORY);

        let Some(TextSearchSource::AutoDownload(files)) = config.text_search else {
            panic!("expected automatic model download");
        };
        assert_eq!(files.model, expected.join(TEXT_SEARCH_MODEL_FILENAME));
        assert_eq!(
            files.vocabulary,
            expected.join(TEXT_SEARCH_VOCABULARY_FILENAME)
        );
    }

    #[test]
    fn automatic_model_download_rejects_a_vocabulary_override() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("pic")).unwrap();
        let args = [
            "--text-search-model",
            "true",
            "--text-search-vocab",
            "vocab.txt",
        ]
        .map(str::to_owned);

        let error = Config::from_sources(temp.path().to_path_buf(), args, |_| None).unwrap_err();
        assert!(error.to_string().contains("automatic model download"));
    }

    #[test]
    fn boolean_false_disables_text_search_and_auto_remains_compatible() {
        let temp = tempfile::tempdir().unwrap();
        assert!(matches!(
            parse_text_search_model(OsString::from("false"), temp.path()),
            TextSearchModelInput::Disabled
        ));
        assert!(matches!(
            parse_text_search_model(OsString::from("auto"), temp.path()),
            TextSearchModelInput::AutoDownload
        ));

        let gallery = temp.path().join("gallery");
        let cache = temp.path().join("cache");
        std::fs::create_dir(&gallery).unwrap();
        let environment = HashMap::from([
            ("PIXHELF_AUTH_ENABLED", OsString::from("false")),
            ("PIXHELF_GALLERY_DIR", gallery.as_os_str().to_os_string()),
            ("PIXHELF_CACHE_DIR", cache.as_os_str().to_os_string()),
            ("PIXHELF_TEXT_SEARCH_MODEL", OsString::from("false")),
        ]);
        let config = Config::from_sources(temp.path().to_path_buf(), [], |name| {
            environment.get(name).cloned()
        })
        .unwrap();
        assert!(config.text_search.is_none());
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
