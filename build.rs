use std::{env, fs, path::PathBuf, process::Command};

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

    if env::var_os("PIXHELF_SKIP_FRONTEND_BUILD").is_none() {
        let status = Command::new("npm")
            .args(["run", "build", "--silent"])
            .current_dir(&frontend_dir)
            .status()
            .expect(
                "failed to run the frontend build; install Node.js and run `npm ci` in frontend/",
            );

        assert!(status.success(), "frontend build failed");
    }

    let asset_version = asset_version(&frontend_dir);
    println!("cargo:rustc-env=PIXHELF_ASSET_VERSION={asset_version}");
}

fn asset_version(frontend_dir: &std::path::Path) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for relative in ["dist/assets/app.js", "dist/assets/app.css"] {
        let path = frontend_dir.join(relative);
        let content = fs::read(&path)
            .unwrap_or_else(|error| panic!("cannot read built asset {}: {error}", path.display()));
        for byte in relative.bytes().chain(content) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}
