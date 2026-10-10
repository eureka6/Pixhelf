//! Compressed, static media tools carried inside the application. Linux executes
//! sealed anonymous memory files; there is no PATH lookup or executable cache.
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::AsRawFd,
    process::Command,
    sync::OnceLock,
};

use anyhow::{Context, Result, anyhow, ensure};
use rustix::fs::{MemfdFlags, SealFlags, fcntl_add_seals, memfd_create};
use sha2::{Digest, Sha256};

include!(concat!(env!("OUT_DIR"), "/media_runtime.rs"));

struct Runtime {
    ffmpeg: File,
    ffprobe: File,
}

#[derive(Clone, Copy)]
pub(crate) enum Tool {
    Ffmpeg,
    Ffprobe,
}

pub(crate) fn command(tool: Tool) -> Result<Command> {
    static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
    let runtime = RUNTIME
        .get_or_init(|| unpack().map_err(|error| format!("{error:#}")))
        .as_ref()
        .map_err(|error| anyhow!("cannot load embedded media runtime: {error}"))?;
    let file = match tool {
        Tool::Ffmpeg => &runtime.ffmpeg,
        Tool::Ffprobe => &runtime.ffprobe,
    };
    // The FD survives fork until exec resolves this path, then CLOEXEC closes it.
    // Runtime owns it for the server lifetime, including concurrent jobs.
    Ok(Command::new(format!("/proc/self/fd/{}", file.as_raw_fd())))
}

fn unpack() -> Result<Runtime> {
    let mut decoder = brotli::Decompressor::new(PACKED, 64 * 1024);
    let mut digest = Sha256::new();
    let mut executable = |name: &str, length: usize| -> Result<File> {
        let flags = MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING;
        let fd = memfd_create(name, flags | MemfdFlags::EXEC).or_else(|error| {
            // MFD_EXEC was introduced in Linux 6.3; older kernels allow exec by default.
            if error == rustix::io::Errno::INVAL {
                memfd_create(name, flags)
            } else {
                Err(error)
            }
        })?;
        let mut file = File::from(fd);
        let mut buffer = [0u8; 64 * 1024];
        let mut remaining = length;
        while remaining > 0 {
            let count = remaining.min(buffer.len());
            decoder.read_exact(&mut buffer[..count])?;
            digest.update(&buffer[..count]);
            file.write_all(&buffer[..count])?;
            remaining -= count;
        }
        fcntl_add_seals(
            &file,
            SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL,
        )?;
        Ok(file)
    };
    let ffmpeg = executable("pixhelf-ffmpeg", LENGTHS[0]).context("unpack ffmpeg")?;
    let ffprobe = executable("pixhelf-ffprobe", LENGTHS[1]).context("unpack ffprobe")?;
    ensure!(
        decoder.read(&mut [0])? == 0,
        "media runtime has trailing data"
    );
    let actual: [u8; 32] = digest.finalize().into();
    ensure!(actual == SHA256, "media runtime checksum mismatch");
    Ok(Runtime { ffmpeg, ffprobe })
}

pub(crate) fn check() -> Result<()> {
    for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
        let mut command = command(tool)?;
        command.arg("-version");
        let output = crate::video::run_cancellable(
            &mut command,
            64 * 1024,
            std::time::Duration::from_secs(30),
            &|| false,
        )?;
        println!(
            "{}",
            String::from_utf8_lossy(&output)
                .lines()
                .next()
                .unwrap_or_default()
        );
    }
    println!("HEIC: heic-rs 0.1.1 (Rust); embedded media ready");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_run_without_path_or_dynamic_libraries() {
        for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
            let output = command(tool)
                .unwrap()
                .env_clear()
                .env("PATH", "/nonexistent")
                .env("LD_LIBRARY_PATH", "/nonexistent")
                .arg("-version")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("8.1.3"));
        }
    }

    #[test]
    fn unpacked_executables_are_sealed_against_modification() {
        let runtime = unpack().unwrap();
        assert!(
            rustix::fs::fcntl_get_seals(&runtime.ffmpeg)
                .unwrap()
                .contains(SealFlags::WRITE)
        );
        assert!((&runtime.ffmpeg).write_all(b"changed").is_err());
    }
}
