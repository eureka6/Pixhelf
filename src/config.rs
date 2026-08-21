use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};

#[derive(Clone, Debug)]
pub struct Config {
    pub gallery_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub listen: SocketAddr,
    pub initial_batch: usize,
    pub workers: usize,
    pub scan_interval: Duration,
}

impl Config {
    pub fn from_env_and_args() -> Result<Self> {
        let cwd = env::current_dir().context("cannot determine the working directory")?;
        let mut gallery_dir = cwd.join("pic");
        let mut cache_dir = cwd.join(".pixhelf-cache").join("thumbnails");
        let mut listen = "0.0.0.0:3002".parse::<SocketAddr>()?;
        let mut initial_batch = 60usize;
        let mut workers = default_worker_count();
        let mut scan_interval = Duration::from_secs(10);

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--gallery-dir" => gallery_dir = path_value(&mut args, &arg, &cwd)?,
                "--cache-dir" => cache_dir = path_value(&mut args, &arg, &cwd)?,
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

        if !gallery_dir.is_dir() {
            bail!(
                "gallery directory does not exist: {}",
                gallery_dir.display()
            );
        }

        std::fs::create_dir_all(&cache_dir)
            .with_context(|| format!("cannot create cache directory: {}", cache_dir.display()))?;

        Ok(Self {
            gallery_dir,
            cache_dir,
            listen,
            initial_batch,
            workers,
            scan_interval,
        })
    }
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
  --cache-dir PATH       Thumbnail and viewer preview cache (default: ./.pixhelf-cache/thumbnails)\n  \
  --listen HOST:PORT     Listen address (default: 0.0.0.0:3002)\n  \
  --initial-batch N      Thumbnails prepared before serving (default: 60)\n  \
  --workers N            Background thumbnail workers (default: 2-4, based on CPU)\n  \
  --scan-interval SEC    Gallery rescan interval (default: 10)\n  \
  -h, --help             Show this help"
    );
}
