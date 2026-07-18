use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Database(Arc<Mutex<Connection>>);

#[derive(Serialize)]
pub struct ImageRow {
    pub id: i64,
    pub name: String,
    pub path: String,
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

impl Database {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192;
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                bytes INTEGER NOT NULL, modified INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS images_name_id ON images(name COLLATE NOCASE, id DESC);",
        )?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert(
        &self,
        path: &Path,
        name: &str,
        mime: &str,
        width: u32,
        height: u32,
        bytes: u64,
        modified: i64,
    ) -> anyhow::Result<()> {
        self.0.lock().unwrap().execute(
            "INSERT INTO images(path,name,mime,width,height,bytes,modified) VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(path) DO UPDATE SET name=excluded.name,mime=excluded.mime,width=excluded.width,height=excluded.height,bytes=excluded.bytes,modified=excluded.modified",
            params![path.to_string_lossy(), name, mime, width, height, bytes, modified])?;
        Ok(())
    }

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
                "SELECT id,name,path,mime,width,height,bytes FROM images
                WHERE name LIKE ?1 ESCAPE '\\' COLLATE NOCASE AND path LIKE ?2 ESCAPE '\\'
                ORDER BY ((id * 1103515245 + ?3) % 2147483647), id LIMIT ?4 OFFSET ?5",
            )?;
            return Ok(stmt
                .query_map(
                    params![needle, folder_needle, seed & 0x7fff_ffff, limit, offset],
                    |r| {
                        Ok(ImageRow {
                            id: r.get(0)?,
                            name: r.get(1)?,
                            path: r.get(2)?,
                            mime: r.get(3)?,
                            width: r.get(4)?,
                            height: r.get(5)?,
                            bytes: r.get(6)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?);
        }
        let mut stmt = conn.prepare(
            "SELECT id,name,path,mime,width,height,bytes FROM images
            WHERE id < ?1 AND name LIKE ?2 ESCAPE '\\' COLLATE NOCASE
            AND path LIKE ?3 ESCAPE '\\' ORDER BY id DESC LIMIT ?4",
        )?;
        Ok(stmt
            .query_map(
                params![cursor.unwrap_or(i64::MAX), needle, folder_needle, limit],
                |r| {
                    Ok(ImageRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                        mime: r.get(3)?,
                        width: r.get(4)?,
                        height: r.get(5)?,
                        bytes: r.get(6)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn paths(&self) -> anyhow::Result<Vec<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM images ORDER BY path COLLATE NOCASE")?;
        Ok(stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn thumbnail_sources(&self) -> anyhow::Result<Vec<(i64, String)>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,path FROM images ORDER BY id")?;
        Ok(stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn by_id(&self, id: i64) -> anyhow::Result<Option<ImageRow>> {
        self.0
            .lock()
            .unwrap()
            .query_row(
                "SELECT id,name,path,mime,width,height,bytes FROM images WHERE id=?1",
                [id],
                |r| {
                    Ok(ImageRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                        mime: r.get(3)?,
                        width: r.get(4)?,
                        height: r.get(5)?,
                        bytes: r.get(6)?,
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
