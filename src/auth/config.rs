use std::{
    ffi::OsString,
    fmt,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use argon2::{Params, PasswordHash};
use ipnet::IpNet;

use super::{guest::GuestConfig, persistence};

#[derive(Clone, Default)]
pub struct AuthConfig {
    pub credentials: Option<Credentials>,
    pub setup: Option<SetupConfig>,
    pub(super) guest: GuestConfig,
}

#[derive(Clone)]
pub struct SetupConfig {
    pub path: PathBuf,
    pub username: String,
    pub public_origin: Option<String>,
    pub trusted_proxies: Vec<IpNet>,
}

#[derive(Clone)]
pub struct Credentials {
    pub username: String,
    pub password_hash: String,
    pub account_path: Option<PathBuf>,
    pub public_origin: Option<String>,
    pub trusted_proxies: Vec<IpNet>,
}

impl fmt::Debug for AuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthConfig")
            .field("enabled", &self.enabled())
            .field("setup_required", &self.setup.is_some())
            .finish_non_exhaustive()
    }
}

impl AuthConfig {
    pub fn enabled(&self) -> bool {
        self.credentials.is_some() || self.setup.is_some()
    }

    pub fn from_sources(
        cwd: &Path,
        cache: &Path,
        get_env: &impl Fn(&str) -> Option<OsString>,
    ) -> Result<Self> {
        let enabled = match setting(get_env, "PIXHELF_AUTH_ENABLED")?.as_deref() {
            None | Some("true") => true,
            Some("false") => false,
            _ => bail!("PIXHELF_AUTH_ENABLED must be true or false"),
        };
        let hash = setting(get_env, "PIXHELF_AUTH_PASSWORD_HASH")?;
        let hash_file = setting(get_env, "PIXHELF_AUTH_PASSWORD_HASH_FILE")?;
        if !enabled {
            if hash.is_some() || hash_file.is_some() {
                bail!("password credentials are configured but PIXHELF_AUTH_ENABLED is false");
            }
            return Ok(Self::default());
        }
        let username = setting(get_env, "PIXHELF_AUTH_USERNAME")?.unwrap_or_else(|| "admin".into());
        validate_username(&username)?;
        let public_origin = setting(get_env, "PIXHELF_PUBLIC_URL")?
            .map(|url| web_origin(&url))
            .transpose()?;
        let mut trusted_proxies = Vec::new();
        if let Some(proxies) = setting(get_env, "PIXHELF_TRUSTED_PROXIES")? {
            for proxy in proxies.split(',') {
                let network = proxy.trim().parse::<IpNet>()
                    .context("PIXHELF_TRUSTED_PROXIES must contain comma-separated IP networks in CIDR notation")?;
                if network.prefix_len() == 0 {
                    bail!("PIXHELF_TRUSTED_PROXIES must not trust the entire internet");
                }
                trusted_proxies.push(network);
            }
        }
        let directory = cache.join("auth");
        persistence::prepare_directory(&directory)?;
        let guest = GuestConfig::load(directory.join("guest.json"))?;
        if hash.is_none() && hash_file.is_none() {
            let path = directory.join("account.json");
            if let Some(mut credentials) = persistence::load(&path)? {
                credentials.public_origin = public_origin;
                credentials.trusted_proxies = trusted_proxies;
                return Ok(Self {
                    credentials: Some(credentials),
                    setup: None,
                    guest,
                });
            }
            return Ok(Self {
                credentials: None,
                setup: Some(SetupConfig {
                    path,
                    username,
                    public_origin,
                    trusted_proxies,
                }),
                guest,
            });
        }
        let password_hash = match (hash, hash_file) {
            (Some(_), Some(_)) => bail!(
                "configure only one of PIXHELF_AUTH_PASSWORD_HASH and PIXHELF_AUTH_PASSWORD_HASH_FILE"
            ),
            (Some(hash), None) => hash,
            (None, Some(path)) => {
                let mut content = String::new();
                std::fs::File::open(cwd.join(path))
                    .context("cannot open PIXHELF_AUTH_PASSWORD_HASH_FILE")?
                    .take(1025)
                    .read_to_string(&mut content)
                    .context("cannot read PIXHELF_AUTH_PASSWORD_HASH_FILE")?;
                if content.len() > 1024 {
                    bail!("password hash file must contain at most 1024 bytes");
                }
                content.trim().to_owned()
            }
            (None, None) => unreachable!("handled web setup above"),
        };
        validate_hash(&password_hash)?;
        Ok(Self {
            credentials: Some(Credentials {
                username,
                password_hash,
                account_path: None,
                public_origin,
                trusted_proxies,
            }),
            setup: None,
            guest,
        })
    }
}

fn setting(get_env: &impl Fn(&str) -> Option<OsString>, name: &str) -> Result<Option<String>> {
    get_env(name)
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("{name} must contain valid Unicode"))
        })
        .transpose()
}

pub(super) fn validate_hash(value: &str) -> Result<()> {
    if value.len() > 1024 {
        bail!("configured password hash is too long");
    }
    let hash = PasswordHash::new(value).map_err(|_| {
        anyhow::anyhow!(
            "configured password hash is not valid PHC format; use pixhelf --hash-password"
        )
    })?;
    let params = Params::try_from(&hash)
        .map_err(|_| anyhow::anyhow!("configured password hash has invalid Argon2 parameters"))?;
    if hash.algorithm.as_str() != "argon2id"
        || hash.version != Some(19)
        || hash.salt.is_none_or(|salt| salt.as_str().len() < 22)
        || hash.hash.is_none_or(|output| output.len() < 32)
        || params.m_cost() < 19_456
        || params.m_cost() > 262_144
        || params.t_cost() < 2
        || params.t_cost() > 10
        || params.p_cost() > 4
    {
        bail!(
            "configured password hash must use Argon2id v19, a 16-byte salt, a 32-byte output, m=19456–262144, t=2–10 and p=1–4; use pixhelf --hash-password"
        );
    }
    Ok(())
}

pub(super) fn validate_username(username: &str) -> Result<()> {
    if username.is_empty()
        || username.len() > 128
        || username.trim() != username
        || username.chars().any(char::is_control)
    {
        bail!("用户名需为 1–128 字节，不能包含首尾空格或控制字符");
    }
    Ok(())
}

pub(super) fn web_origin(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).context("invalid HTTP or HTTPS address")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "HTTP or HTTPS address must be an origin without credentials, subpath, query or fragment"
        );
    }
    Ok(url.origin().ascii_serialization())
}
