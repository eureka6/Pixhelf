use std::{
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use quick_xml::{XmlVersion, events::Event, name::ResolveResult, reader::NsReader};

const CAMERA_NS: &[u8] = b"http://ns.google.com/photos/1.0/camera/";
const ITEM_NS: &[u8] = b"http://ns.google.com/photos/1.0/container/item/";
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const MAX_JPEG_HEADER: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MotionSource {
    pub id: String,
    pub path: PathBuf,
    pub offset: u64,
    pub length: u64,
    pub mime: &'static str,
    size: u64,
    modified_ns: u128,
}

impl MotionSource {
    pub fn matches_metadata(&self, metadata: &fs::Metadata) -> bool {
        metadata.is_file()
            && metadata.len() == self.size
            && modified_ns(metadata) == self.modified_ns
    }

    fn from_file(path: &Path, offset: u64, length: u64) -> Option<Self> {
        let mut file = File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || length == 0 || offset.checked_add(length)? > metadata.len() {
            return None;
        }
        let mime = video_mime(&mut file, offset, length)?;
        let modified_ns = modified_ns(&metadata);
        let mut hash = blake3::Hasher::new();
        hash.update(b"pixhelf-motion-v2\0");
        hash.update(path.to_str()?.as_bytes());
        hash.update(&metadata.len().to_le_bytes());
        hash.update(&modified_ns.to_le_bytes());
        hash.update(&offset.to_le_bytes());
        hash.update(&length.to_le_bytes());
        Some(Self {
            id: hash.finalize().to_hex().to_string(),
            path: path.to_owned(),
            offset,
            length,
            mime,
            size: metadata.len(),
            modified_ns,
        })
    }
}

fn modified_ns(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

pub fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mov" | "mp4" | "m4v"
            )
        })
}

pub fn pairing_key(path: &Path) -> Option<(PathBuf, String)> {
    Some((
        path.parent()?.to_owned(),
        path.file_stem()?.to_str()?.to_lowercase(),
    ))
}

pub fn paired_video(path: &Path) -> Option<MotionSource> {
    MotionSource::from_file(path, 0, fs::metadata(path).ok()?.len())
}

// Read only JPEG metadata and container headers, never decode or copy the video while scanning.
pub fn embedded_video(path: &Path) -> Option<MotionSource> {
    let mut reader = BufReader::new(File::open(path).ok()?);
    let size = reader.get_ref().metadata().ok()?.len();
    let mut marker = [0; 2];
    reader.read_exact(&mut marker).ok()?;
    if marker != [0xff, 0xd8] {
        return None;
    }
    // Samsung's SEF index gives exact clip bounds. Its XMP length can include the
    // SEF footer, which is not part of the MP4 and must not be sent to the player.
    if let Some((offset, length)) = samsung_video(&mut reader, size)
        && let Some(source) = MotionSource::from_file(path, offset, length)
    {
        return Some(source);
    }
    reader.seek(SeekFrom::Start(2)).ok()?;
    while reader.stream_position().ok()? < MAX_JPEG_HEADER {
        reader.read_exact(&mut marker).ok()?;
        if marker[0] != 0xff {
            return None;
        }
        while marker[1] == 0xff {
            reader.read_exact(&mut marker[1..]).ok()?;
        }
        if matches!(marker[1], 0xda | 0xd9) {
            return None;
        }
        if matches!(marker[1], 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let mut bytes = [0; 2];
        reader.read_exact(&mut bytes).ok()?;
        let length = u16::from_be_bytes(bytes).checked_sub(2)?;
        if marker[1] == 0xe1 {
            let mut segment = vec![0; usize::from(length)];
            reader.read_exact(&mut segment).ok()?;
            if let Some(xmp) = segment.strip_prefix(XMP_HEADER)
                && let Some(length) = video_length(xmp)
                && let Some(offset) = size.checked_sub(length)
                && offset >= reader.stream_position().ok()?
                && let Some(source) = MotionSource::from_file(path, offset, length)
            {
                return Some(source);
            }
        } else {
            reader.seek(SeekFrom::Current(i64::from(length))).ok()?;
        }
    }
    None
}

fn samsung_video(reader: &mut (impl Read + Seek), size: u64) -> Option<(u64, u64)> {
    reader.seek(SeekFrom::Start(size.checked_sub(8)?)).ok()?;
    let mut footer = [0; 8];
    reader.read_exact(&mut footer).ok()?;
    if &footer[4..] != b"SEFT" {
        return None;
    }
    let index_length = u32::from_le_bytes(footer[..4].try_into().ok()?);
    if !(12..=12 + 4096 * 12).contains(&index_length) {
        return None;
    }
    let index_start = size.checked_sub(u64::from(index_length) + 8)?;
    reader.seek(SeekFrom::Start(index_start)).ok()?;
    let mut index = vec![0; index_length as usize];
    reader.read_exact(&mut index).ok()?;
    let count = u32::from_le_bytes(index[8..12].try_into().ok()?);
    if &index[..4] != b"SEFH" || u64::from(count) * 12 + 12 != u64::from(index_length) {
        return None;
    }
    for entry in index[12..].chunks_exact(12) {
        if u16::from_le_bytes(entry[2..4].try_into().ok()?) != 0x0a30 {
            continue;
        }
        let backward = u64::from(u32::from_le_bytes(entry[4..8].try_into().ok()?));
        let record_length = u64::from(u32::from_le_bytes(entry[8..].try_into().ok()?));
        let record_start = index_start.checked_sub(backward)?;
        if record_start < 2 || record_length < 24 || record_length > backward {
            return None;
        }
        reader.seek(SeekFrom::Start(record_start)).ok()?;
        let mut record = [0; 24];
        reader.read_exact(&mut record).ok()?;
        if record[..4] != entry[..4]
            || u32::from_le_bytes(record[4..8].try_into().ok()?) != 16
            || &record[8..] != b"MotionPhoto_Data"
        {
            return None;
        }
        let offset = record_start + 24;
        let length = record_length - 24;
        if length == 12 {
            let mut reference = [0; 12];
            reader.read_exact(&mut reference).ok()?;
            if &reference[..4] != b"mpv2" {
                return None;
            }
            let offset = u64::from(u32::from_be_bytes(reference[4..8].try_into().ok()?));
            let length = u64::from(u32::from_be_bytes(reference[8..].try_into().ok()?));
            if offset < 2 || offset.checked_add(length)? > record_start {
                return None;
            }
            return Some((offset, length));
        }
        return Some((offset, length));
    }
    None
}

fn video_mime(file: &mut File, offset: u64, length: u64) -> Option<&'static str> {
    let end = offset.checked_add(length)?;
    let mut position = offset;
    let mut mime = None;
    let mut movie = false;
    let mut media = false;
    for _ in 0..4096 {
        if position == end {
            return (movie && media).then_some(mime?);
        }
        if end.checked_sub(position)? < 8 {
            return None;
        }
        file.seek(SeekFrom::Start(position)).ok()?;
        let mut header = [0; 8];
        file.read_exact(&mut header).ok()?;
        let size = u32::from_be_bytes(header[..4].try_into().ok()?);
        let (size, header_size) = match size {
            0 => (end - position, 8),
            1 => {
                let mut extended = [0; 8];
                file.read_exact(&mut extended).ok()?;
                (u64::from_be_bytes(extended), 16)
            }
            value => (u64::from(value), 8),
        };
        if size < header_size || position.checked_add(size)? > end {
            return None;
        }
        match &header[4..] {
            b"ftyp" if position == offset && size >= header_size + 8 => {
                let mut brand = [0; 4];
                file.read_exact(&mut brand).ok()?;
                mime = Some(if brand == *b"qt  " {
                    "video/quicktime"
                } else {
                    "video/mp4"
                });
            }
            b"moov" => movie = size > header_size,
            b"mdat" => media = size > header_size,
            _ => {}
        }
        if mime.is_none() {
            return None;
        }
        position += size;
    }
    None
}

#[derive(Default)]
struct Item {
    mime: String,
    semantic: String,
    length: Option<u64>,
    property: Option<Property>,
}

#[derive(Clone, Copy)]
enum Property {
    Mime,
    Semantic,
    Length,
    LegacyOffset,
}

fn property(namespace: ResolveResult<'_>, name: &[u8]) -> Option<Property> {
    match namespace {
        ResolveResult::Bound(namespace) if namespace.as_ref() == ITEM_NS => match name {
            b"Mime" => Some(Property::Mime),
            b"Semantic" => Some(Property::Semantic),
            b"Length" => Some(Property::Length),
            _ => None,
        },
        ResolveResult::Bound(namespace)
            if namespace.as_ref() == CAMERA_NS && name == b"MicroVideoOffset" =>
        {
            Some(Property::LegacyOffset)
        }
        _ => None,
    }
}

fn set_property(item: &mut Item, property: Property, value: &str, legacy: &mut Option<u64>) {
    match property {
        Property::Mime => item.mime = value.trim().to_owned(),
        Property::Semantic => item.semantic = value.trim().to_owned(),
        Property::Length => item.length = value.trim().parse().ok(),
        Property::LegacyOffset => *legacy = value.trim().parse().ok(),
    }
}

// Resolve XML namespaces so Android vendor prefixes and RDF attribute/element forms both work.
fn video_length(xmp: &[u8]) -> Option<u64> {
    let mut reader = NsReader::from_reader(xmp);
    reader.config_mut().trim_text(true);
    let mut stack = Vec::<Item>::new();
    let mut legacy = None;
    let mut motion = None;
    loop {
        let event = reader.read_event().ok()?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                if stack.len() >= 64 {
                    return None;
                }
                let (namespace, name) = reader.resolver().resolve_element(element.name());
                let mut item = Item {
                    property: property(namespace, name.as_ref()),
                    ..Item::default()
                };
                for attribute in element.attributes() {
                    let attribute = attribute.ok()?;
                    let (namespace, name) = reader.resolver().resolve_attribute(attribute.key);
                    if let Some(property) = property(namespace, name.as_ref()) {
                        let value = attribute
                            .decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                            .ok()?;
                        set_property(&mut item, property, &value, &mut legacy);
                    }
                }
                stack.push(item);
                if matches!(event, Event::Empty(_)) {
                    finish_item(stack.pop()?, &mut motion)?;
                }
            }
            Event::Text(text) => {
                if let Some(property) = stack.last()?.property {
                    let value = text.decode().ok()?;
                    let index = stack.len().checked_sub(2)?;
                    set_property(&mut stack[index], property, &value, &mut legacy);
                }
            }
            Event::End(_) => finish_item(stack.pop()?, &mut motion)?,
            Event::Eof => break,
            Event::DocType(_) => return None,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return None;
    }
    motion.or(legacy).filter(|length| *length > 0)
}

fn finish_item(item: Item, motion: &mut Option<u64>) -> Option<()> {
    if item.semantic == "MotionPhoto"
        && matches!(item.mime.as_str(), "video/mp4" | "video/quicktime")
    {
        if motion.is_some() {
            return None;
        }
        *motion = Some(item.length.filter(|length| *length > 0)?);
    }
    Some(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn video_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        for (kind, data) in [
            (b"ftyp", &b"isom\0\0\0\0isom"[..]),
            (b"moov", &b"test"[..]),
            (b"mdat", &b"frames"[..]),
        ] {
            bytes.extend_from_slice(&((data.len() + 8) as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(data);
        }
        bytes
    }

    pub fn motion_jpeg(path: &Path, xmp: &str, video: &[u8]) {
        let mut image = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(20, 10)
            .write_to(&mut image, image::ImageFormat::Jpeg)
            .unwrap();
        let image = image.into_inner();
        let mut bytes = image[..2].to_vec();
        bytes.extend_from_slice(&[0xff, 0xe1]);
        bytes.extend_from_slice(&((2 + XMP_HEADER.len() + xmp.len()) as u16).to_be_bytes());
        bytes.extend_from_slice(XMP_HEADER);
        bytes.extend_from_slice(xmp.as_bytes());
        bytes.extend_from_slice(&image[2..]);
        bytes.extend_from_slice(video);
        fs::write(path, bytes).unwrap();
    }

    pub fn samsung_jpeg(path: &Path, video: &[u8], reference: bool) {
        motion_jpeg(path, "<x/>", &[]);
        let mut bytes = fs::read(path).unwrap();
        let video_offset = bytes.len();
        if reference {
            bytes.extend_from_slice(video);
        }
        let record_start = bytes.len();
        bytes.extend_from_slice(&[0, 0, 0x30, 0x0a]);
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(b"MotionPhoto_Data");
        if reference {
            bytes.extend_from_slice(b"mpv2");
            bytes.extend_from_slice(&(video_offset as u32).to_be_bytes());
            bytes.extend_from_slice(&(video.len() as u32).to_be_bytes());
        } else {
            bytes.extend_from_slice(video);
        }
        let record_length = bytes.len() - record_start;
        // Additional vendor data can follow the clip before the SEF index.
        bytes.extend_from_slice(b"unrelated vendor metadata");
        let backward = bytes.len() - record_start;
        bytes.extend_from_slice(b"SEFH");
        bytes.extend_from_slice(&106_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0x30, 0x0a]);
        bytes.extend_from_slice(&(backward as u32).to_le_bytes());
        bytes.extend_from_slice(&(record_length as u32).to_le_bytes());
        bytes.extend_from_slice(&24_u32.to_le_bytes());
        bytes.extend_from_slice(b"SEFT");
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn extracts_samsung_sef_clips_and_mpv2_references_without_vendor_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("samsung.jpg");
        let video = video_bytes();
        for reference in [false, true] {
            samsung_jpeg(&path, &video, reference);
            let source = embedded_video(&path).unwrap();
            assert_eq!(source.length, video.len() as u64);
            let bytes = fs::read(&path).unwrap();
            let end = source.offset + source.length;
            assert!(end < bytes.len() as u64);
            assert_eq!(&bytes[source.offset as usize..end as usize], &video);
        }
    }

    #[test]
    fn rejects_invalid_samsung_index_offsets_lengths_and_record_names() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("samsung.jpg");
        samsung_jpeg(&path, &video_bytes(), false);
        let original = fs::read(&path).unwrap();
        let index = original.len() - 32;
        let backward = u32::from_le_bytes(original[index + 16..index + 20].try_into().unwrap());
        let record = index - backward as usize;
        for offset in [
            original.len() - 8,
            index + 8,
            index + 16,
            index + 20,
            record + 4,
            record + 8,
            record + 24,
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            fs::write(&path, &bytes).unwrap();
            assert!(
                embedded_video(&path).is_none(),
                "accepted corrupt data at {offset}"
            );
        }
        samsung_jpeg(&path, &video_bytes(), true);
        let mut bytes = fs::read(&path).unwrap();
        let reference = bytes.windows(4).position(|bytes| bytes == b"mpv2").unwrap();
        bytes[reference + 4..reference + 8].copy_from_slice(&u32::MAX.to_be_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(embedded_video(&path).is_none());
    }

    #[test]
    fn locates_embedded_video_with_legacy_xmp_and_rejects_stale_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("motion.jpg");
        let video = video_bytes();
        let xmp = format!(
            r#"<x xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideoOffset="{}"/>"#,
            video.len()
        );
        motion_jpeg(&path, &xmp, &video);
        let source = embedded_video(&path).unwrap();
        assert_eq!(source.length, video.len() as u64);
        assert!(source.offset > 0);
        assert!(source.matches_metadata(&fs::metadata(&path).unwrap()));
        motion_jpeg(&path, &xmp, &[]);
        assert!(embedded_video(&path).is_none());
        assert!(!source.matches_metadata(&fs::metadata(&path).unwrap()));
    }

    #[test]
    fn reads_container_items_without_confusing_gainmap_lengths() {
        let xmp = br#"<x xmlns:c="http://ns.google.com/photos/1.0/container/" xmlns:v="http://ns.google.com/photos/1.0/container/item/">
          <c:Item v:Semantic="Primary" v:Mime="image/jpeg" v:Length="0"/>
          <c:Item v:Semantic="GainMap" v:Mime="image/jpeg" v:Length="999"/>
          <c:Item><v:Semantic>MotionPhoto</v:Semantic><v:Mime>video/mp4</v:Mime><v:Length>46</v:Length></c:Item>
        </x>"#;
        assert_eq!(video_length(xmp), Some(46));
        assert_eq!(
            video_length(br#"<x xmlns:c="wrong" c:MicroVideoOffset="46"/>"#),
            None
        );
        assert_eq!(video_length(br#"<x xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideoOffset="18446744073709551616"/>"#), None);
        assert_eq!(
            video_length(
                br#"<x xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideoOffset="46">"#
            ),
            None
        );
    }

    #[test]
    fn rejects_truncated_video_boxes_and_non_video_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("photo.MOV");
        let bytes = video_bytes();
        fs::write(&path, &bytes).unwrap();
        assert!(paired_video(&path).is_some());
        fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
        assert!(paired_video(&path).is_none());
        fs::write(&path, b"not a video").unwrap();
        assert!(paired_video(&path).is_none());
    }
}
