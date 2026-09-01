use std::{fs::File, io::BufReader, path::Path};

use anyhow::{Context, Result};
use exif::{Exif, In, Tag, Value};
use serde::Serialize;

use crate::gallery::ImageRecord;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhotoDetails {
    pub(crate) file_size: u64,
    pub(crate) modified_ms: u64,
    pub(crate) exif: Vec<ExifField>,
    pub(crate) histogram: PhotoHistogram,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ExifField {
    pub(crate) label: &'static str,
    pub(crate) value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct PhotoHistogram {
    pub(crate) red: Vec<u32>,
    pub(crate) green: Vec<u32>,
    pub(crate) blue: Vec<u32>,
    pub(crate) luminance: Vec<u32>,
}

impl PhotoDetails {
    pub(crate) fn read(record: &ImageRecord, thumbnail: &Path) -> Result<Self> {
        record.ensure_source_is_current()?;
        let exif = read_exif(&record.path)?;
        let histogram = read_histogram(thumbnail)?;
        record.ensure_source_is_current()?;
        Ok(Self {
            file_size: record.size,
            modified_ms: record.modified_ms,
            exif,
            histogram,
        })
    }
}

fn read_histogram(path: &Path) -> Result<PhotoHistogram> {
    let image = image::open(path)
        .with_context(|| format!("cannot decode histogram source {}", path.display()))?
        .to_rgb8();
    let mut red = vec![0_u32; 256];
    let mut green = vec![0_u32; 256];
    let mut blue = vec![0_u32; 256];
    let mut luminance = vec![0_u32; 256];

    for pixel in image.pixels() {
        let [r, g, b] = pixel.0;
        red[usize::from(r)] += 1;
        green[usize::from(g)] += 1;
        blue[usize::from(b)] += 1;
        // Integer Rec. 709 coefficients, rounded to the nearest 8-bit value.
        let luma =
            (54_u16 * u16::from(r) + 183_u16 * u16::from(g) + 19_u16 * u16::from(b) + 128) >> 8;
        luminance[usize::from(luma)] += 1;
    }

    Ok(PhotoHistogram {
        red,
        green,
        blue,
        luminance,
    })
}

fn read_exif(path: &Path) -> Result<Vec<ExifField>> {
    let file =
        File::open(path).with_context(|| format!("cannot open EXIF source {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut parser = exif::Reader::new();
    parser.continue_on_error(true);
    let Some(exif) = parser
        .read_from_container(&mut reader)
        .or_else(|error| error.distill_partial_result(|_| {}))
        .ok()
    else {
        return Ok(Vec::new());
    };

    Ok(exif_fields(&exif))
}

fn exif_fields(exif: &Exif) -> Vec<ExifField> {
    let mut fields = Vec::with_capacity(14);

    if let Some(mut captured_at) = ascii_value(exif, Tag::DateTimeOriginal)
        .or_else(|| ascii_value(exif, Tag::DateTimeDigitized))
        .or_else(|| ascii_value(exif, Tag::DateTime))
    {
        captured_at = normalize_exif_datetime(&captured_at);
        if let Some(offset) = ascii_value(exif, Tag::OffsetTimeOriginal)
            .or_else(|| ascii_value(exif, Tag::OffsetTimeDigitized))
            .or_else(|| ascii_value(exif, Tag::OffsetTime))
        {
            captured_at.push(' ');
            captured_at.push_str(&offset);
        }
        push_field(&mut fields, "拍摄时间", Some(captured_at));
    }

    push_field(
        &mut fields,
        "色彩空间",
        unsigned_value(exif, Tag::ColorSpace).map(|value| match value {
            1 => "sRGB".to_owned(),
            0xffff => "未校准".to_owned(),
            _ => value.to_string(),
        }),
    );

    let make = ascii_value(exif, Tag::Make);
    let model = ascii_value(exif, Tag::Model);
    push_field(&mut fields, "相机", combine_make_and_model(make, model));
    push_field(&mut fields, "镜头", ascii_value(exif, Tag::LensModel));
    push_field(
        &mut fields,
        "快门",
        rational_value(exif, Tag::ExposureTime).map(format_exposure_time),
    );
    push_field(
        &mut fields,
        "光圈",
        rational_value(exif, Tag::FNumber).map(|value| format!("f/{}", compact_decimal(value))),
    );
    push_field(
        &mut fields,
        "ISO",
        unsigned_value(exif, Tag::PhotographicSensitivity)
            .or_else(|| unsigned_value(exif, Tag::ISOSpeed))
            .or_else(|| unsigned_value(exif, Tag::RecommendedExposureIndex))
            .map(|value| value.to_string()),
    );
    push_field(
        &mut fields,
        "焦距",
        rational_value(exif, Tag::FocalLength)
            .map(|value| format!("{} mm", compact_decimal(value))),
    );
    push_field(
        &mut fields,
        "35mm 等效",
        unsigned_value(exif, Tag::FocalLengthIn35mmFilm)
            .filter(|value| *value > 0)
            .map(|value| format!("{value} mm")),
    );
    push_field(
        &mut fields,
        "曝光补偿",
        signed_rational_value(exif, Tag::ExposureBiasValue).map(format_exposure_bias),
    );
    push_field(
        &mut fields,
        "曝光程序",
        unsigned_value(exif, Tag::ExposureProgram).map(exposure_program),
    );
    push_field(
        &mut fields,
        "测光模式",
        unsigned_value(exif, Tag::MeteringMode).map(metering_mode),
    );
    push_field(
        &mut fields,
        "闪光灯",
        unsigned_value(exif, Tag::Flash).map(|value| {
            if value & 1 == 1 {
                "已闪光".to_owned()
            } else {
                "未闪光".to_owned()
            }
        }),
    );
    push_field(
        &mut fields,
        "白平衡",
        unsigned_value(exif, Tag::WhiteBalance).map(|value| match value {
            0 => "自动".to_owned(),
            1 => "手动".to_owned(),
            _ => value.to_string(),
        }),
    );
    push_field(&mut fields, "处理软件", ascii_value(exif, Tag::Software));

    fields
}

fn push_field(fields: &mut Vec<ExifField>, label: &'static str, value: Option<String>) {
    let Some(value) = value.map(|value| value.trim().to_owned()) else {
        return;
    };
    if !value.is_empty() {
        fields.push(ExifField { label, value });
    }
}

fn field_value(exif: &Exif, tag: Tag) -> Option<&Value> {
    exif.get_field(tag, In::PRIMARY).map(|field| &field.value)
}

fn ascii_value(exif: &Exif, tag: Tag) -> Option<String> {
    let Value::Ascii(values) = field_value(exif, tag)? else {
        return None;
    };
    let value = values.first()?;
    let value = String::from_utf8_lossy(value)
        .trim_matches(|character: char| character == '\0' || character.is_whitespace())
        .to_owned();
    (!value.is_empty()).then_some(value)
}

fn unsigned_value(exif: &Exif, tag: Tag) -> Option<u32> {
    field_value(exif, tag)?.get_uint(0)
}

fn rational_value(exif: &Exif, tag: Tag) -> Option<f64> {
    match field_value(exif, tag)? {
        Value::Rational(values) => values.first().map(|value| value.to_f64()),
        _ => None,
    }
    .filter(|value| value.is_finite() && *value >= 0.0)
}

fn signed_rational_value(exif: &Exif, tag: Tag) -> Option<f64> {
    match field_value(exif, tag)? {
        Value::SRational(values) => values.first().map(|value| value.to_f64()),
        Value::Rational(values) => values.first().map(|value| value.to_f64()),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn normalize_exif_datetime(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 10 && bytes.get(4) == Some(&b':') && bytes.get(7) == Some(&b':') {
        if let (Some(year), Some(month), Some(day), Some(rest)) = (
            value.get(..4),
            value.get(5..7),
            value.get(8..10),
            value.get(10..),
        ) {
            return format!("{year}-{month}-{day}{rest}");
        }
        value.to_owned()
    } else {
        value.to_owned()
    }
}

fn combine_make_and_model(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase()) => {
            Some(model)
        }
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (Some(make), None) => Some(make),
        (None, Some(model)) => Some(model),
        (None, None) => None,
    }
}

fn format_exposure_time(seconds: f64) -> String {
    if seconds <= 0.0 {
        return "0 秒".to_owned();
    }
    if seconds < 1.0 {
        let denominator = (1.0 / seconds).round();
        let reciprocal = 1.0 / seconds;
        if denominator.is_finite()
            && denominator >= 1.0
            && (reciprocal - denominator).abs() <= (reciprocal * 0.005).max(0.01)
        {
            return format!("1/{} 秒", denominator as u64);
        }
    }
    format!("{} 秒", compact_decimal(seconds))
}

fn format_exposure_bias(value: f64) -> String {
    if value.abs() < 0.005 {
        "0 EV".to_owned()
    } else {
        format!("{value:+.1} EV")
    }
}

fn compact_decimal(value: f64) -> String {
    if (value - value.round()).abs() < 0.005 {
        format!("{value:.0}")
    } else if value.abs() < 10.0 {
        format!("{value:.1}")
    } else {
        format!("{value:.0}")
    }
}

fn exposure_program(value: u32) -> String {
    match value {
        0 => "未定义".to_owned(),
        1 => "手动".to_owned(),
        2 => "程序自动".to_owned(),
        3 => "光圈优先".to_owned(),
        4 => "快门优先".to_owned(),
        5 => "创意程序".to_owned(),
        6 => "动作程序".to_owned(),
        7 => "人像模式".to_owned(),
        8 => "风景模式".to_owned(),
        _ => value.to_string(),
    }
}

fn metering_mode(value: u32) -> String {
    match value {
        0 => "未知".to_owned(),
        1 => "平均".to_owned(),
        2 => "中央重点平均".to_owned(),
        3 => "点测光".to_owned(),
        4 => "多点测光".to_owned(),
        5 => "多区测光".to_owned(),
        6 => "局部测光".to_owned(),
        255 => "其他".to_owned(),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use exif::{Field, Rational};
    use image::ImageEncoder;
    use std::io::Cursor;

    #[test]
    fn histogram_counts_rgb_and_luminance_bins() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("histogram.png");
        let mut image = image::RgbImage::new(2, 1);
        image.put_pixel(0, 0, image::Rgb([255, 0, 0]));
        image.put_pixel(1, 0, image::Rgb([0, 255, 0]));
        image.save(&path).unwrap();

        let histogram = read_histogram(&path).unwrap();
        assert_eq!(histogram.red[0], 1);
        assert_eq!(histogram.red[255], 1);
        assert_eq!(histogram.green[0], 1);
        assert_eq!(histogram.green[255], 1);
        assert_eq!(histogram.blue[0], 2);
        assert_eq!(histogram.luminance.iter().sum::<u32>(), 2);
    }

    #[test]
    fn formats_common_photography_values() {
        assert_eq!(
            normalize_exif_datetime("2026:08:29 14:03:02"),
            "2026-08-29 14:03:02"
        );
        assert_eq!(
            combine_make_and_model(Some("Canon".into()), Some("Canon EOS R6".into())),
            Some("Canon EOS R6".into())
        );
        assert_eq!(format_exposure_time(1.0 / 125.0), "1/125 秒");
        assert_eq!(format_exposure_time(1.3), "1.3 秒");
        assert_eq!(format_exposure_time(0.4), "0.4 秒");
        assert_eq!(format_exposure_bias(-2.0 / 3.0), "-0.7 EV");
    }

    #[test]
    fn reads_curated_fields_from_a_jpeg_container() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("camera.jpg");
        let fields = [
            Field {
                tag: Tag::Make,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"Canon".to_vec()]),
            },
            Field {
                tag: Tag::Model,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"Canon EOS R6".to_vec()]),
            },
            Field {
                tag: Tag::DateTimeOriginal,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"2026:08:29 14:03:02".to_vec()]),
            },
            Field {
                tag: Tag::ExposureTime,
                ifd_num: In::PRIMARY,
                value: Value::Rational(vec![Rational { num: 1, denom: 125 }]),
            },
            Field {
                tag: Tag::FNumber,
                ifd_num: In::PRIMARY,
                value: Value::Rational(vec![Rational { num: 28, denom: 10 }]),
            },
            Field {
                tag: Tag::PhotographicSensitivity,
                ifd_num: In::PRIMARY,
                value: Value::Short(vec![400]),
            },
            Field {
                tag: Tag::ColorSpace,
                ifd_num: In::PRIMARY,
                value: Value::Short(vec![1]),
            },
        ];
        let mut metadata = Cursor::new(Vec::new());
        let mut writer = exif::experimental::Writer::new();
        for field in &fields {
            writer.push_field(field);
        }
        writer.write(&mut metadata, false).unwrap();

        let file = File::create(&path).unwrap();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 90);
        encoder.set_exif_metadata(metadata.into_inner()).unwrap();
        encoder
            .write_image(
                &[180, 90, 30, 30, 90, 180],
                2,
                1,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();

        let fields = read_exif(&path).unwrap();
        let value = |label| {
            fields
                .iter()
                .find(|field| field.label == label)
                .map(|field| field.value.as_str())
        };
        assert_eq!(value("拍摄时间"), Some("2026-08-29 14:03:02"));
        assert_eq!(value("相机"), Some("Canon EOS R6"));
        assert_eq!(value("快门"), Some("1/125 秒"));
        assert_eq!(value("光圈"), Some("f/2.8"));
        assert_eq!(value("ISO"), Some("400"));
        assert_eq!(value("色彩空间"), Some("sRGB"));
    }
}
