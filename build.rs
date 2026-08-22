use std::{env, path::PathBuf, process::Command};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let frontend_dir = manifest_dir.join("frontend");

    for path in [
        "frontend/index.html",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/tsconfig.json",
        "frontend/vite.config.ts",
        "frontend/src",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=PIXHELF_SKIP_FRONTEND_BUILD");

    if env::var_os("PIXHELF_SKIP_FRONTEND_BUILD").is_some() {
        return;
    }

    let status = Command::new("npm")
        .args(["run", "build", "--silent"])
        .current_dir(frontend_dir)
        .status()
        .expect("failed to run the frontend build; install Node.js and run `npm ci` in frontend/");

    assert!(status.success(), "frontend build failed");
}
