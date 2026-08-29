use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{Context, Result, bail};

pub(crate) const FINGERPRINT_BYTES: usize = 16;
const CHECKSUM_BYTES: usize = 16;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) type Fingerprint = [u8; FINGERPRINT_BYTES];

pub(crate) const fn sidecar_length(embedding_size: usize) -> u64 {
    (8 + FINGERPRINT_BYTES + embedding_size + CHECKSUM_BYTES) as u64
}

#[derive(Clone, Debug)]
pub(crate) struct QuantizedEmbedding<const SIZE: usize> {
    values: [i8; SIZE],
    norm: f32,
}

impl<const SIZE: usize> QuantizedEmbedding<SIZE> {
    pub(crate) fn quantize(values: &[f32], label: &str) -> Result<Self> {
        if values.len() != SIZE || values.iter().any(|value| !value.is_finite()) {
            bail!("{label} returned an invalid embedding");
        }
        let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm <= f32::EPSILON {
            bail!("{label} returned an empty embedding");
        }
        let values = std::array::from_fn(|index| {
            (values[index] / norm * 127.0).round().clamp(-127.0, 127.0) as i8
        });
        Self::from_quantized(values, label)
    }

    fn from_quantized(values: [i8; SIZE], label: &str) -> Result<Self> {
        let norm = values
            .iter()
            .map(|value| f32::from(*value).powi(2))
            .sum::<f32>()
            .sqrt();
        if norm <= f32::EPSILON {
            bail!("{label} is empty");
        }
        Ok(Self { values, norm })
    }

    pub(crate) fn cosine_similarity(&self, other: &Self) -> f32 {
        let dot = self
            .values
            .iter()
            .zip(&other.values)
            .map(|(left, right)| f32::from(*left) * f32::from(*right))
            .sum::<f32>();
        (dot / (self.norm * other.norm)).clamp(-1.0, 1.0)
    }

    #[cfg(test)]
    pub(crate) fn for_test(values: impl IntoIterator<Item = (usize, i8)>) -> Self {
        let mut embedding = [0_i8; SIZE];
        for (index, value) in values {
            embedding[index] = value;
        }
        Self::from_quantized(embedding, "test embedding").expect("test embedding must not be empty")
    }
}

pub(crate) fn sidecar_path(thumbnail: &Path, extension: &str) -> PathBuf {
    thumbnail.with_extension(extension)
}

pub(crate) fn is_sidecar(path: &Path, extension: &str) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some(extension)
}

pub(crate) fn remove_sidecar(thumbnail: &Path, extension: &str) -> std::io::Result<()> {
    match fs::remove_file(sidecar_path(thumbnail, extension)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(crate) fn read_sidecar<const SIZE: usize>(
    path: &Path,
    expected_fingerprint: &Fingerprint,
    magic: &[u8; 8],
    label: &str,
) -> Result<QuantizedEmbedding<SIZE>> {
    let expected_length = sidecar_length(SIZE);
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() != expected_length {
        bail!("{label} cache has an unexpected size");
    }

    let mut file = File::open(path)?;
    let mut stored_magic = [0_u8; 8];
    file.read_exact(&mut stored_magic)?;
    if &stored_magic != magic {
        bail!("{label} cache has an unknown version");
    }
    let mut fingerprint = [0_u8; FINGERPRINT_BYTES];
    file.read_exact(&mut fingerprint)?;
    if &fingerprint != expected_fingerprint {
        bail!("{label} belongs to another model");
    }
    let mut values = [0_u8; SIZE];
    file.read_exact(&mut values)?;
    let mut checksum = [0_u8; CHECKSUM_BYTES];
    file.read_exact(&mut checksum)?;
    if checksum != embedding_checksum(&fingerprint, &values) {
        bail!("{label} cache checksum does not match");
    }
    QuantizedEmbedding::from_quantized(values.map(|value| value as i8), label)
}

pub(crate) fn write_sidecar<const SIZE: usize>(
    path: &Path,
    fingerprint: &Fingerprint,
    magic: &[u8; 8],
    embedding: &QuantizedEmbedding<SIZE>,
    label: &str,
) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("invalid {label} cache path: {}", path.display()))?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("embedding"),
        std::process::id(),
        sequence
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(magic)?;
        file.write_all(fingerprint)?;
        let values = embedding.values.map(|value| value as u8);
        file.write_all(&values)?;
        file.write_all(&embedding_checksum(fingerprint, &values))?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn embedding_checksum<const SIZE: usize>(
    fingerprint: &Fingerprint,
    values: &[u8; SIZE],
) -> [u8; CHECKSUM_BYTES] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(fingerprint);
    hasher.update(values);
    let mut checksum = [0_u8; CHECKSUM_BYTES];
    checksum.copy_from_slice(&hasher.finalize().as_bytes()[..CHECKSUM_BYTES]);
    checksum
}

pub(crate) fn fingerprint_files(paths: &[&Path], label: &str) -> Result<Fingerprint> {
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 128 * 1024];
    for path in paths {
        let mut file =
            File::open(path).with_context(|| format!("cannot open {label}: {}", path.display()))?;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        hasher.update(b"\0");
    }
    let mut fingerprint = [0_u8; FINGERPRINT_BYTES];
    fingerprint.copy_from_slice(&hasher.finalize().as_bytes()[..FINGERPRINT_BYTES]);
    Ok(fingerprint)
}

pub(crate) fn fingerprint_token(fingerprint: &Fingerprint) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(FINGERPRINT_BYTES * 2);
    for byte in fingerprint {
        token.push(HEX[usize::from(byte >> 4)] as char);
        token.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    token
}

#[cfg(test)]
mod tests {
    use super::QuantizedEmbedding;

    #[test]
    fn rejects_invalid_embeddings() {
        assert!(QuantizedEmbedding::<2>::quantize(&[1.0], "model").is_err());
        assert!(QuantizedEmbedding::<2>::quantize(&[0.0, 0.0], "model").is_err());
        assert!(QuantizedEmbedding::<2>::quantize(&[f32::NAN, 1.0], "model").is_err());
    }
}
