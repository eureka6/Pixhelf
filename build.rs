use std::{collections::BTreeMap, env, fs, path::PathBuf, process::Command};

#[derive(serde::Deserialize)]
struct PackedGroup {
    filename: String,
    length: usize,
    files: Vec<PackedFile>,
}

#[derive(serde::Deserialize)]
struct PackedFile {
    name: String,
    offset: usize,
    length: usize,
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let frontend_dir = manifest_dir.join("frontend");

    for path in [
        "frontend/index.html",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/tsconfig.json",
        "frontend/tsconfig.app.json",
        "frontend/vite.config.ts",
        "frontend/libmedia-assets.json",
        "frontend/scripts/prepare-libmedia.mjs",
        "frontend/scripts/pack-assets.mjs",
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
    } else {
        println!("cargo:rerun-if-changed=frontend/dist");
    }

    let assets_dir = frontend_dir.join("dist/assets");
    let output_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let packed_dir = output_dir.join("frontend-packed");
    let status = Command::new("node")
        .arg(frontend_dir.join("scripts/pack-assets.mjs"))
        .arg(&assets_dir)
        .arg(&packed_dir)
        .status()
        .expect("failed to run frontend asset packing; install Node.js");
    assert!(status.success(), "frontend asset packing failed");
    let groups: Vec<PackedGroup> = serde_json::from_slice(
        &fs::read(packed_dir.join("manifest.json")).expect("read packed asset manifest"),
    )
    .expect("invalid packed asset manifest");
    let mut packed_files = BTreeMap::new();
    let mut embedded = String::from("const ASSET_GROUPS: &[AssetGroup] = &[\n");
    for (index, group) in groups.iter().enumerate() {
        embedded.push_str(&format!(
            "AssetGroup {{ compressed: include_bytes!({:?}), length: {} }},\n",
            packed_dir.join(&group.filename).to_string_lossy(),
            group.length,
        ));
        for file in &group.files {
            assert!(file.offset + file.length <= group.length);
            assert!(
                packed_files
                    .insert(file.name.as_str(), (index, file.offset, file.length))
                    .is_none(),
                "duplicate packed asset"
            );
        }
    }
    embedded.push_str("];\nconst FRONTEND_ASSETS: &[Asset] = &[\n");
    let mut assets = Vec::new();
    collect_assets(&assets_dir, &mut assets);
    assets.sort();
    for path in &assets {
        let name = path
            .strip_prefix(&assets_dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let source = match packed_files.remove(name.as_str()) {
            Some((group, offset, length)) => {
                format!(
                    "AssetSource::Packed {{ group: {group}, offset: {offset}, length: {length} }}"
                )
            }
            None => {
                assert!(
                    !name.starts_with("libmedia/"),
                    "unpacked libmedia asset: {name}"
                );
                format!(
                    "AssetSource::Plain(include_bytes!({:?}))",
                    path.to_string_lossy()
                )
            }
        };
        embedded.push_str(&format!("Asset {{ name: {name:?}, source: {source} }},\n"));
    }
    assert!(
        packed_files.is_empty(),
        "packed assets missing from frontend output"
    );
    embedded.push_str("];\n");
    fs::write(output_dir.join("frontend_assets.rs"), embedded)
        .expect("write embedded frontend assets");
    let asset_version = asset_version(&frontend_dir, &assets);
    println!("cargo:rustc-env=PIXHELF_ASSET_VERSION={asset_version}");
}

fn collect_assets(directory: &std::path::Path, assets: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read frontend assets") {
        let entry = entry.expect("read frontend asset");
        if entry.file_type().expect("asset type").is_dir() {
            collect_assets(&entry.path(), assets);
        } else {
            assets.push(entry.path());
        }
    }
}

fn asset_version(frontend_dir: &std::path::Path, assets: &[PathBuf]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for path in std::iter::once(frontend_dir.join("dist/index.html")).chain(assets.iter().cloned())
    {
        let relative = path
            .strip_prefix(frontend_dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let content = fs::read(&path)
            .unwrap_or_else(|error| panic!("cannot read built asset {}: {error}", path.display()));
        for byte in relative.bytes().chain(content) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}
