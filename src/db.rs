use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const IMAGE_METADATA_VERSION: i64 = 2;

#[derive(Clone)]
pub struct Database(Arc<Mutex<Connection>>);

#[derive(Serialize)]
pub struct ImageRow {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub thumb_key: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct Stats {
    pub images: u64,
    pub bytes: u64,
}

pub struct ImageMetadata {
    pub path: PathBuf,
    pub name: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub modified: i64,
}

pub struct ScanCleanup {
    pub removed: u64,
    pub skipped_empty: bool,
}

fn add_parent_folders(path: &Path, folders: &mut BTreeSet<String>) {
    let Some(parent) = path.parent() else {
        return;
    };
    let mut current = PathBuf::new();
    for component in parent.components() {
        current.push(component);
        let folder = current.to_string_lossy().replace('\\', "/");
        if !folder.is_empty() {
            folders.insert(folder);
        }
    }
}

impl Database {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192;
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                bytes INTEGER NOT NULL, modified INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folders (
                path TEXT PRIMARY KEY
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS gallery_meta (
                key TEXT PRIMARY KEY, value INTEGER NOT NULL
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS images_name_id ON images(name COLLATE NOCASE, id DESC);",
        )?;
        let folders_initialized = conn
            .query_row(
                "SELECT value FROM gallery_meta WHERE key='folders_initialized'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if !folders_initialized {
            let image_paths = {
                let mut statement = conn.prepare("SELECT path FROM images")?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let mut folders = BTreeSet::new();
            for path in &image_paths {
                add_parent_folders(Path::new(path), &mut folders);
            }
            let transaction = conn.transaction()?;
            {
                let mut statement =
                    transaction.prepare_cached("INSERT OR IGNORE INTO folders(path) VALUES(?1)")?;
                for folder in folders {
                    statement.execute([folder])?;
                }
            }
            transaction.execute(
                "INSERT INTO gallery_meta(key,value) VALUES('folders_initialized',1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [],
            )?;
            transaction.commit()?;
        }
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    pub fn file_snapshot(&self) -> anyhow::Result<HashMap<String, (u64, i64)>> {
        let conn = self.0.lock().unwrap();
        let metadata_version = conn
            .query_row(
                "SELECT value FROM gallery_meta WHERE key='image_metadata_version'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if metadata_version != Some(IMAGE_METADATA_VERSION) {
            return Ok(HashMap::new());
        }
        let mut statement = conn.prepare("SELECT path,bytes,modified FROM images")?;
        Ok(statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, u64>(1)?, row.get::<_, i64>(2)?),
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?)
    }

    pub fn begin_scan(&self) -> anyhow::Result<()> {
        self.0.lock().unwrap().execute_batch(
            "DROP TABLE IF EXISTS temp.scan_seen;
             DROP TABLE IF EXISTS temp.scan_seen_folders;
             CREATE TEMP TABLE scan_seen (
                 path TEXT PRIMARY KEY
             ) WITHOUT ROWID;
             CREATE TEMP TABLE scan_seen_folders (
                 path TEXT PRIMARY KEY
             ) WITHOUT ROWID;",
        )?;
        Ok(())
    }

    pub fn commit_scan_batch(
        &self,
        images: &[ImageMetadata],
        seen_paths: &[PathBuf],
    ) -> anyhow::Result<()> {
        if images.is_empty() && seen_paths.is_empty() {
            return Ok(());
        }
        let mut folders = BTreeSet::new();
        for path in seen_paths {
            add_parent_folders(path, &mut folders);
        }
        let mut conn = self.0.lock().unwrap();
        let transaction = conn.transaction()?;
        {
            let mut statement = transaction.prepare_cached(
                "INSERT INTO images(path,name,mime,width,height,bytes,modified)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(path) DO UPDATE SET
                    name=excluded.name,mime=excluded.mime,width=excluded.width,
                    height=excluded.height,bytes=excluded.bytes,modified=excluded.modified",
            )?;
            for image in images {
                statement.execute(params![
                    image.path.to_string_lossy(),
                    image.name,
                    image.mime,
                    image.width,
                    image.height,
                    image.bytes,
                    image.modified
                ])?;
            }
        }
        {
            let mut statement =
                transaction.prepare_cached("INSERT OR IGNORE INTO scan_seen(path) VALUES(?1)")?;
            for path in seen_paths {
                statement.execute([path.to_string_lossy()])?;
            }
        }
        {
            let mut seen_statement = transaction
                .prepare_cached("INSERT OR IGNORE INTO scan_seen_folders(path) VALUES(?1)")?;
            let mut folder_statement =
                transaction.prepare_cached("INSERT OR IGNORE INTO folders(path) VALUES(?1)")?;
            for folder in folders {
                seen_statement.execute([&folder])?;
                folder_statement.execute([folder])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn finish_scan(&self) -> anyhow::Result<ScanCleanup> {
        let mut conn = self.0.lock().unwrap();
        let transaction = conn.transaction()?;
        let indexed: u64 =
            transaction.query_row("SELECT count(*) FROM images", [], |row| row.get(0))?;
        let seen: u64 =
            transaction.query_row("SELECT count(*) FROM scan_seen", [], |row| row.get(0))?;
        // An empty mounted directory can mean that removable or network storage
        // is temporarily unavailable. Keep the old index until a later non-empty
        // scan can reconcile it normally.
        let skipped_empty = indexed > 0 && seen == 0;
        let removed = if skipped_empty {
            0
        } else {
            let removed = transaction.execute(
                "DELETE FROM images
                 WHERE NOT EXISTS (
                     SELECT 1 FROM scan_seen WHERE scan_seen.path=images.path
                 )",
                [],
            )? as u64;
            transaction.execute(
                "DELETE FROM folders
                 WHERE NOT EXISTS (
                     SELECT 1 FROM scan_seen_folders
                     WHERE scan_seen_folders.path=folders.path
                 )",
                [],
            )?;
            transaction.execute(
                "INSERT INTO gallery_meta(key,value) VALUES('image_metadata_version',?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [IMAGE_METADATA_VERSION],
            )?;
            removed
        };
        transaction.execute_batch("DROP TABLE scan_seen; DROP TABLE scan_seen_folders;")?;
        transaction.commit()?;
        Ok(ScanCleanup {
            removed,
            skipped_empty,
        })
    }

    pub fn abort_scan(&self) {
        let _ = self.0.lock().unwrap().execute_batch(
            "DROP TABLE IF EXISTS temp.scan_seen;
                 DROP TABLE IF EXISTS temp.scan_seen_folders;",
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list(
        &self,
        cursor: Option<i64>,
        limit: u32,
        search: Option<&str>,
        folder: Option<&str>,
        random: bool,
        seed: i64,
        offset: u32,
    ) -> anyhow::Result<Vec<ImageRow>> {
        let conn = self.0.lock().unwrap();
        let needle = format!(
            "%{}%",
            search
                .unwrap_or_default()
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let folder = folder.unwrap_or_default().trim_matches('/');
        let folder_needle = if folder.is_empty() {
            "%".to_owned()
        } else {
            format!("{}/%", folder.replace('%', "\\%").replace('_', "\\_"))
        };
        if random {
            let mut stmt = conn.prepare(
                "SELECT id,name,path,mime,width,height,bytes,modified FROM images
                WHERE name LIKE ?1 ESCAPE '\\' COLLATE NOCASE AND path LIKE ?2 ESCAPE '\\'
                ORDER BY ((id * 1103515245 + ?3) % 2147483647), id LIMIT ?4 OFFSET ?5",
            )?;
            return Ok(stmt
                .query_map(
                    params![needle, folder_needle, seed & 0x7fff_ffff, limit, offset],
                    |r| {
                        let path: String = r.get(2)?;
                        let bytes = r.get(6)?;
                        let modified = r.get(7)?;
                        Ok(ImageRow {
                            id: r.get(0)?,
                            name: r.get(1)?,
                            thumb_key: crate::thumbs::version(Path::new(&path), modified, bytes),
                            path,
                            mime: r.get(3)?,
                            width: r.get(4)?,
                            height: r.get(5)?,
                            bytes,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?);
        }
        let mut stmt = conn.prepare(
            "SELECT id,name,path,mime,width,height,bytes,modified FROM images
            WHERE id > ?1 AND name LIKE ?2 ESCAPE '\\' COLLATE NOCASE
            AND path LIKE ?3 ESCAPE '\\'
            ORDER BY id ASC LIMIT ?4",
        )?;
        Ok(stmt
            .query_map(
                params![cursor.unwrap_or(0), needle, folder_needle, limit],
                |r| {
                    let path: String = r.get(2)?;
                    let bytes = r.get(6)?;
                    let modified = r.get(7)?;
                    Ok(ImageRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        thumb_key: crate::thumbs::version(Path::new(&path), modified, bytes),
                        path,
                        mime: r.get(3)?,
                        width: r.get(4)?,
                        height: r.get(5)?,
                        bytes,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn folders(&self) -> anyhow::Result<Vec<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM folders ORDER BY path COLLATE NOCASE")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn thumbnail_sources_after(
        &self,
        after_id: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<(i64, String)>> {
        let conn = self.0.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id,path FROM images WHERE id>?1 ORDER BY id LIMIT ?2")?;
        Ok(stmt
            .query_map(params![after_id, limit], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn by_id(&self, id: i64) -> anyhow::Result<Option<ImageRow>> {
        self.0
            .lock()
            .unwrap()
            .query_row(
                "SELECT id,name,path,mime,width,height,bytes,modified FROM images WHERE id=?1",
                [id],
                |r| {
                    let path: String = r.get(2)?;
                    let bytes = r.get(6)?;
                    let modified = r.get(7)?;
                    Ok(ImageRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        thumb_key: crate::thumbs::version(Path::new(&path), modified, bytes),
                        path,
                        mime: r.get(3)?,
                        width: r.get(4)?,
                        height: r.get(5)?,
                        bytes,
                    })
                },
            )
            .optional()
            .context("query image")
    }

    pub fn stats(&self) -> anyhow::Result<Stats> {
        self.0
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*),coalesce(sum(bytes),0) FROM images",
                [],
                |r| {
                    Ok(Stats {
                        images: r.get(0)?,
                        bytes: r.get(1)?,
                    })
                },
            )
            .context("query stats")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn opening_an_existing_database_builds_the_folder_index_once() {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let workspace =
            std::env::temp_dir().join(format!("pixhelf-db-folders-{}-{id}", std::process::id()));
        fs::create_dir_all(&workspace).unwrap();
        let path = workspace.join("gallery.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE images (
                    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                    mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                    bytes INTEGER NOT NULL, modified INTEGER NOT NULL
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO images(path,name,mime,width,height,bytes,modified)
                 VALUES('albums/trips/one.jpg','one.jpg','image/jpeg',1,1,1,1)",
                [],
            )
            .unwrap();
        }

        let db = Database::open(path).unwrap();
        assert_eq!(db.folders().unwrap(), ["albums", "albums/trips"]);

        fs::remove_dir_all(workspace).unwrap();
    }
}
