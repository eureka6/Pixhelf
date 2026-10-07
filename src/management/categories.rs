use std::{collections::HashSet, fs, path::Path, sync::Arc};

use anyhow::{Context, Result, ensure};
use axum::{Json, extract::State, response::Response};
use serde::{Deserialize, Serialize};

use super::{Failure, Management, files::save_json, private_json};
use crate::web::AppState;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Category {
    name: String,
    query: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Categories {
    categories: Vec<Category>,
}

impl Default for Categories {
    fn default() -> Self {
        Self {
            categories: serde_json::from_str(include_str!(
                "../../frontend/src/defaultCategories.json"
            ))
            .expect("valid bundled categories"),
        }
    }
}

impl Categories {
    fn validate(&mut self) -> Result<()> {
        ensure!(self.categories.len() <= 24, "最多添加 24 个分类");
        let mut names = HashSet::new();
        let mut queries = HashSet::new();
        for category in &mut self.categories {
            category.name = category.name.trim().to_owned();
            category.query = category.query.trim().to_owned();
            ensure!(
                !category.name.is_empty() && category.name.chars().count() <= 24,
                "分类名称需为 1–24 个字"
            );
            ensure!(
                !category.query.is_empty() && category.query.chars().count() <= 200,
                "搜索描述需为 1–200 个字"
            );
            ensure!(
                !category.name.chars().any(char::is_control)
                    && !category.query.chars().any(char::is_control),
                "分类不能包含控制字符"
            );
            ensure!(
                names.insert(category.name.to_lowercase()),
                "分类名称不能重复"
            );
            ensure!(
                queries.insert(category.query.to_lowercase()),
                "搜索描述不能重复"
            );
        }
        Ok(())
    }
}

fn load(directory: &Path) -> Result<Categories> {
    match fs::read(directory.join("categories.json")) {
        Ok(bytes) => {
            ensure!(bytes.len() <= 64 * 1024, "分类设置文件过大");
            let mut saved: Categories =
                serde_json::from_slice(&bytes).context("分类设置损坏，请恢复数据文件后重试")?;
            saved.validate()?;
            Ok(saved)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Categories::default()),
        Err(error) => Err(error).context("无法读取分类设置"),
    }
}

pub(crate) async fn read(State(app): State<AppState>) -> Result<Response, Failure> {
    let directory = app.thumbnails.settings_directory().join("management");
    let categories = tokio::task::spawn_blocking(move || load(&directory))
        .await
        .context("读取分类设置失败")??;
    Ok(private_json(categories))
}

pub(super) async fn save(
    State(store): State<Arc<Management>>,
    Json(mut input): Json<Categories>,
) -> Result<Response, Failure> {
    input.validate()?;
    let guard = store.updates.clone().lock_owned().await;
    let directory = store.directory.clone();
    let saved = tokio::task::spawn_blocking(move || -> Result<_> {
        let _guard = guard;
        save_json(&directory.join("categories.json"), &input).context("无法保存分类设置")?;
        Ok(input)
    })
    .await
    .context("保存分类设置失败")??;
    Ok(private_json(saved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_validate_and_persist_without_replacing_valid_settings() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(load(directory.path()).unwrap().categories.len(), 6);
        let mut categories = Categories {
            categories: vec![Category {
                name: " 旅行 ".into(),
                query: " 海边的日落 ".into(),
            }],
        };
        categories.validate().unwrap();
        save_json(&directory.path().join("categories.json"), &categories).unwrap();
        let saved = load(directory.path()).unwrap();
        assert_eq!(saved.categories[0].name, "旅行");
        assert_eq!(saved.categories[0].query, "海边的日落");
        for (name, query) in [
            ("", "海边"),
            ("旅行", ""),
            ("重复", "海边的日落"),
            ("旅行", "其他"),
            ("换\n行", "其他"),
        ] {
            let mut invalid = Categories {
                categories: vec![
                    saved.categories[0].clone(),
                    Category {
                        name: name.into(),
                        query: query.into(),
                    },
                ],
            };
            assert!(invalid.validate().is_err());
        }
        let mut too_many = Categories {
            categories: vec![saved.categories[0].clone(); 25],
        };
        assert!(too_many.validate().is_err());
        fs::write(directory.path().join("categories.json"), b"broken").unwrap();
        assert!(
            load(directory.path()).is_err(),
            "corrupt settings must not silently become defaults"
        );
    }
}
