use std::io::{self, IsTerminal, Read};

use anyhow::{Context, Result, bail};
use argon2::{
    Argon2, PasswordHasher,
    password_hash::{SaltString, rand_core::OsRng},
};
use zeroize::Zeroizing;

pub fn print_password_hash() -> Result<()> {
    let password = if io::stdin().is_terminal() {
        Zeroizing::new(rpassword::prompt_password(
            "Password (at least 15 characters): ",
        )?)
    } else {
        let mut password = Zeroizing::new(String::new());
        io::stdin()
            .take(1027)
            .read_to_string(&mut password)
            .context("cannot read password from stdin")?;
        if password.ends_with('\n') {
            password.pop();
            if password.ends_with('\r') {
                password.pop();
            }
        }
        password
    };
    validate_password(&password)?;
    println!("{}", hash_password(&password)?);
    Ok(())
}

pub(super) fn validate_password(password: &str) -> Result<()> {
    if password.chars().count() < 15
        || password.len() > 1024
        || password.chars().any(char::is_control)
    {
        bail!("密码需至少 15 个字符、最多 1024 字节，且不能包含控制字符");
    }
    Ok(())
}

pub(super) fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| anyhow::anyhow!("cannot hash password"))?;
    Ok(hash.to_string())
}
