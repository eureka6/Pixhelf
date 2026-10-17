use std::{cmp::Reverse, sync::Arc};

use super::models::{
    ImageKind, ImageOrientation, ImageRequest, ImageSort, ImageView, ImagesResponse,
};
use crate::gallery::{GalleryIndex, ImageRecord};

pub(super) fn image_page(index: &GalleryIndex, query: &ImageRequest) -> ImagesResponse {
    if query.album.is_none()
        && query.search.is_none()
        && query.kind == ImageKind::All
        && query.orientation == ImageOrientation::All
    {
        let total = index.images.len();
        let offset = query.offset.min(total);
        let items = match query.sort {
            ImageSort::Default | ImageSort::NameAsc => Some(
                index
                    .images
                    .iter()
                    .skip(offset)
                    .take(query.limit)
                    .map(|record| ImageView::from(record.as_ref()))
                    .collect(),
            ),
            ImageSort::NameDesc => Some(
                index
                    .images
                    .iter()
                    .rev()
                    .skip(offset)
                    .take(query.limit)
                    .map(|record| ImageView::from(record.as_ref()))
                    .collect(),
            ),
            _ => None,
        };
        if let Some(items) = items {
            return finish_page(items, total, offset, query.limit);
        }
    }
    image_page_from_records(index.images.iter().map(Arc::as_ref), query)
}

// Callers supply records in the index's natural filename order. Filtering stays
// lazy so gallery and favorites name pages allocate only the returned items.
pub(crate) fn image_page_from_records<'a>(
    records: impl DoubleEndedIterator<Item = &'a ImageRecord>,
    query: &ImageRequest,
) -> ImagesResponse {
    let records = records.filter(|record| {
        query
            .album
            .as_deref()
            .is_none_or(|album| record.belongs_to_album(album))
            && query
                .search
                .as_deref()
                .is_none_or(|search| record.search_key.contains(search))
            && query.matches_filters(record)
    });
    sorted_image_page(records, query)
}

pub(super) fn sorted_image_page<'a>(
    records: impl DoubleEndedIterator<Item = &'a ImageRecord>,
    query: &ImageRequest,
) -> ImagesResponse {
    match query.sort {
        ImageSort::Default | ImageSort::NameAsc => page_from_ordered_records(records, query),
        ImageSort::NameDesc => page_from_ordered_records(records.rev(), query),
        ImageSort::Newest => {
            page_from_ranked_records(records, query, |record| Reverse(record.modified_ms))
        }
        ImageSort::Oldest => page_from_ranked_records(records, query, |record| record.modified_ms),
        ImageSort::Explore => {
            let seed = *blake3::hash(query.seed.as_bytes()).as_bytes();
            page_from_ranked_records(records, query, |record| exploration_rank(&seed, &record.id))
        }
    }
}

fn page_from_ordered_records<'a>(
    records: impl Iterator<Item = &'a ImageRecord>,
    query: &ImageRequest,
) -> ImagesResponse {
    let mut items = Vec::with_capacity(query.limit);
    let mut total = 0usize;
    for record in records {
        if total >= query.offset && items.len() < query.limit {
            items.push(ImageView::from(record));
        }
        total += 1;
    }
    finish_page(items, total, query.offset, query.limit)
}

fn page_from_ranked_records<'a, K: Ord>(
    records: impl Iterator<Item = &'a ImageRecord>,
    query: &ImageRequest,
    rank: impl Fn(&ImageRecord) -> K,
) -> ImagesResponse {
    let mut ranked: Vec<_> = records
        .enumerate()
        .map(|(order, record)| (rank(record), order, record))
        .collect();
    let total = ranked.len();
    let offset = query.offset.min(total);
    if offset == total {
        return finish_page(Vec::new(), total, offset, query.limit);
    }

    // Partition around the requested page, then sort only that page. The input
    // order breaks ties exactly as the previous stable full sort did.
    let compare = |left: &(K, usize, &ImageRecord), right: &(K, usize, &ImageRecord)| {
        left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1))
    };
    if offset > 0 {
        ranked.select_nth_unstable_by(offset, compare);
    }
    let remaining = &mut ranked[offset..];
    let count = query.limit.min(remaining.len());
    if count < remaining.len() {
        remaining.select_nth_unstable_by(count, compare);
    }
    let page = &mut remaining[..count];
    page.sort_unstable_by(compare);
    let items = page
        .iter()
        .map(|(_, _, record)| ImageView::from(*record))
        .collect();
    finish_page(items, total, offset, query.limit)
}

pub(super) fn finish_page(
    items: Vec<ImageView>,
    total: usize,
    requested_offset: usize,
    limit: usize,
) -> ImagesResponse {
    let offset = requested_offset.min(total);
    let end = offset.saturating_add(items.len()).min(total);
    ImagesResponse {
        items,
        total,
        offset,
        limit,
        next_offset: (end < total).then_some(end),
    }
}

pub(super) fn exploration_rank(seed_key: &[u8; 32], image_id: &str) -> [u8; 32] {
    *blake3::keyed_hash(seed_key, image_id.as_bytes()).as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_match_full_sort_with_ties_filters_and_large_offsets() {
        let mut index = GalleryIndex::default();
        index.images = (0..301)
            .map(|order| {
                let name = format!("photo-{order:03}.png");
                Arc::new(ImageRecord {
                    id: format!("{order:032x}"),
                    path: name.clone().into(),
                    relative_path: name.clone(),
                    search_key: name.clone(),
                    name,
                    album: if order % 2 == 0 { "even" } else { "odd" }.into(),
                    width: 4,
                    height: 3,
                    size: 12,
                    modified_ms: (order * 37 % 17) as u64,
                    modified_ns: 0,
                    motion: None,
                    video: None,
                })
            })
            .collect();

        for sort in [
            ImageSort::Default,
            ImageSort::NameAsc,
            ImageSort::NameDesc,
            ImageSort::Newest,
            ImageSort::Oldest,
            ImageSort::Explore,
        ] {
            for (album, search) in [
                (None, None),
                (Some("even"), Some("1")),
                (Some("missing"), None),
            ] {
                for seed in ["first", "second"] {
                    let mut expected: Vec<_> = index
                        .images
                        .iter()
                        .filter(|record| {
                            album.is_none_or(|album| record.album == album)
                                && search.is_none_or(|search| record.name.contains(search))
                        })
                        .collect();
                    match sort {
                        ImageSort::Default | ImageSort::NameAsc => {}
                        ImageSort::NameDesc => expected.reverse(),
                        ImageSort::Newest => {
                            expected.sort_by_key(|record| Reverse(record.modified_ms))
                        }
                        ImageSort::Oldest => expected.sort_by_key(|record| record.modified_ms),
                        ImageSort::Explore => {
                            let key = *blake3::hash(seed.as_bytes()).as_bytes();
                            expected
                                .sort_by_cached_key(|record| exploration_rank(&key, &record.id));
                        }
                    }
                    for offset in [0, 1, 59, 120, 300, 301, usize::MAX] {
                        for limit in [1, 60, 200] {
                            let query = ImageRequest {
                                album: album.map(str::to_owned),
                                search: search.map(str::to_owned),
                                sort,
                                seed: seed.into(),
                                offset,
                                limit,
                                ..ImageRequest::default()
                            };
                            let page = image_page(&index, &query);
                            let expected_ids: Vec<_> = expected
                                .iter()
                                .skip(offset)
                                .take(limit)
                                .map(|record| &record.id)
                                .collect();
                            assert_eq!(
                                page.items.iter().map(|item| &item.id).collect::<Vec<_>>(),
                                expected_ids,
                                "{query:?}"
                            );
                            assert_eq!(page.total, expected.len());
                            assert_eq!(page.offset, offset.min(expected.len()));
                            assert_eq!(page.limit, limit);
                            let end = page.offset + page.items.len();
                            assert_eq!(page.next_offset, (end < expected.len()).then_some(end));
                        }
                    }
                }
            }
        }
    }
}
