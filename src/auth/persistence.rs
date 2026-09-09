use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use super::config::{Credentials, validate_hash, validate_username, web_origin};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountFile {
    version: u8,
    username: String,
    password_hash: String,
    // Older versions saved the first browser address. Accept it without pinning future logins.
    #[serde(default, skip_serializing)]
    public_origin: Option<String>,
}

pub(super) fn load(path: &Path) -> Result<Option<Credentials>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("cannot open saved administrator account"),
    };
    let mut bytes = Vec::new();
    file.take(16_385)
        .read_to_end(&mut bytes)
        .context("cannot read saved administrator account")?;
    if bytes.len() > 16_384 {
        bail!("saved administrator account is too large");
    }
    let account: AccountFile = serde_json::from_slice(&bytes).context(
        "saved administrator account is invalid; restore its backup instead of repeating setup",
    )?;
    if account.version != 1 {
        bail!("unsupported administrator account version");
    }
    validate_username(&account.username)?;
    validate_hash(&account.password_hash)?;
    if let Some(origin) = account.public_origin {
        web_origin(&origin)?;
    }
    Ok(Some(Credentials {
        username: account.username,
        password_hash: account.password_hash,
        account_path: Some(path.to_path_buf()),
        public_origin: None,
        trusted_proxies: Vec::new(),
    }))
}

pub(super) fn prepare_directory(directory: &Path) -> Result<()> {
    fs::create_dir_all(directory).context("cannot create administrator configuration directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .context("cannot protect administrator configuration directory")?;
    }
    Ok(())
}

/// Commit a complete account exactly once. Failed writes never replace a valid account.
pub(super) fn create(path: &Path, credentials: &Credentials) -> Result<()> {
    save(path, credentials, false)
}

pub(super) fn replace(path: &Path, credentials: &Credentials) -> Result<()> {
    save(path, credentials, true)
}

fn save(path: &Path, credentials: &Credentials, replace: bool) -> Result<()> {
    let account = AccountFile {
        version: 1,
        username: credentials.username.clone(),
        password_hash: credentials.password_hash.clone(),
        public_origin: None,
    };
    write_json(path, &account, replace)
}

pub(super) fn write_json(path: &Path, value: &impl Serialize, replace: bool) -> Result<()> {
    let directory = path
        .parent()
        .context("missing authentication configuration directory")?;
    // Keep the file private and publish complete contents with a same-directory rename.
    let mut temporary = tempfile::Builder::new()
        .prefix(".auth-")
        .suffix(".pending")
        .tempfile_in(directory)
        .context("cannot create temporary administrator configuration")?;
    serde_json::to_writer_pretty(&mut temporary, value)
        .context("cannot encode administrator configuration")?;
    temporary.write_all(b"\n")?;
    temporary
        .as_file()
        .sync_all()
        .context("cannot flush administrator configuration")?;
    if replace {
        temporary
            .persist(path)
            .context("cannot replace administrator configuration")?;
    } else {
        temporary
            .persist_noclobber(path)
            .context("cannot save administrator configuration; an account may already exist")?;
    }
    #[cfg(unix)]
    fs::File::open(directory)?
        .sync_all()
        .context("cannot flush administrator configuration directory")?;
    Ok(())
}
