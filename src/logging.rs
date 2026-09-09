use std::io::{self, IsTerminal};

use time::macros::format_description;
use tracing_subscriber::{EnvFilter, fmt::time::UtcTime};

// Fatal errors must remain visible even with RUST_LOG=off.
pub(crate) const FATAL_TARGET: &str = "pixhelf::fatal";

pub(crate) fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,pixhelf=info"))
        .add_directive(
            format!("{FATAL_TARGET}=error")
                .parse()
                .expect("the built-in log directive is valid"),
        );

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_timer(UtcTime::new(format_description!(
            "[year]-[month]-[day] [hour]:[minute]:[second]Z"
        )))
        .with_target(false)
        .with_ansi(io::stderr().is_terminal())
        .with_writer(io::stderr)
        .compact()
        .init();
}
