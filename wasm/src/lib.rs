//! jpexs-web browser-native SWF layer (Milestone 2 scaffold).
//!
//! Thin `wasm-bindgen` wrapper around the Ruffle `swf` crate (0.3.x).
//! Deliberately conservative: every accessor used here was verified against
//! docs.rs/swf 0.3.0, and per-tag payloads are only read via `Debug`
//! formatting so minor 0.3.x drift can't break the build.
//!
//! Milestone 3 insertion points are marked at the bottom
//! (`replace_bitmap`, `set_place_matrix`).

use wasm_bindgen::prelude::*;

fn err(prefix: &str, e: impl core::fmt::Debug) -> JsValue {
    JsValue::from_str(&format!("{prefix}: {e:?}"))
}

/// Runs `f` on a parsed SWF. The `Swf` value borrows from the decompressed
/// buffer, so both must live in the same scope — hence the closure shape
/// (returning `Swf` itself would be E0515: reference to local `buf`).
fn with_swf<T>(bytes: &[u8], f: impl FnOnce(swf::Swf<'_>) -> Result<T, JsValue>) -> Result<T, JsValue> {
    let buf = swf::decompress_swf(&bytes[..]).map_err(|e| err("decompress", e))?;
    let swf = swf::parse_swf(&buf).map_err(|e| err("parse", e))?;
    f(swf)
}

fn tag_kind(tag: &swf::Tag<'_>) -> &'static str {
    match tag {
        swf::Tag::End => "End",
        swf::Tag::ShowFrame => "ShowFrame",
        swf::Tag::DefineShape(_) => "DefineShape",
        swf::Tag::DefineSprite(_) => "DefineSprite",
        swf::Tag::DefineBits { .. } => "DefineBits",
        swf::Tag::DefineBitsJpeg2 { .. } => "DefineBitsJPEG2",
        swf::Tag::DefineBitsJpeg3(_) => "DefineBitsJPEG3",
        swf::Tag::DefineBitsLossless(_) => "DefineBitsLossless",
        swf::Tag::JpegTables(_) => "JPEGTables",
        swf::Tag::PlaceObject(_) => "PlaceObject",
        swf::Tag::RemoveObject(_) => "RemoveObject",
        swf::Tag::DoAbc(_) => "DoABC",
        swf::Tag::DoAbc2(_) => "DoABC2",
        swf::Tag::DoAction(_) => "DoAction",
        swf::Tag::SymbolClass(_) => "SymbolClass",
        swf::Tag::DefineSound(_) => "DefineSound",
        swf::Tag::DefineBinaryData(_) => "DefineBinaryData",
        swf::Tag::FileAttributes(_) => "FileAttributes",
        swf::Tag::SetBackgroundColor(_) => "SetBackgroundColor",
        swf::Tag::Metadata(_) => "Metadata",
        swf::Tag::Unknown { .. } => "Unknown",
        _ => "Other",
    }
}

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .chars()
        .take(240)
        .collect()
}

/// Full parse of an SWF file → JSON summary.
///
/// Returns e.g.
/// `{"version":12,"frameRate":24.0,"numFrames":1,"as3":false,
///   "numTags":8,"tags":[{"index":0,"kind":"FileAttributes","debug":"…"}]}`
///
/// `frameRate` is numeric fps (`Fixed8::to_f64`); per-tag `debug` is the
/// crate's own `Debug` formatting, truncated client-side for display.
#[wasm_bindgen]
pub fn inspect(bytes: &[u8]) -> Result<String, JsValue> {
    with_swf(bytes, |swf| {
        let mut tags_json = String::from("[");
        for (i, tag) in swf.tags.iter().enumerate() {
            if i > 0 {
                tags_json.push(',');
            }
            let kind = tag_kind(tag);
            let debug = escape_json(&format!("{tag:?}"));
            tags_json.push_str(&format!(
                "{{\"index\":{i},\"kind\":\"{kind}\",\"debug\":\"{debug}\"}}"
            ));
        }
        tags_json.push(']');
        Ok(format!(
            "{{\"version\":{},\"frameRate\":{},\"numFrames\":{},\"as3\":{},\"numTags\":{},\"tags\":{tags_json}}}",
            swf.header.version(),
            swf.header.frame_rate().to_f64(),
            swf.header.num_frames(),
            swf.header.is_action_script_3(),
            swf.tags.len(),
        ))
    })
}

/// Lossless parse → serialize round-trip. Byte-identity is NOT guaranteed
/// (the writer normalizes long-form tag headers), but tag-identity is:
/// use it as the write-path smoke test before implementing Milestone 3 ops.
#[wasm_bindgen]
pub fn roundtrip(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    with_swf(bytes, |swf| {
        // `swf_header()` is the documented 0.3.x route from HeaderExt back to the
        // writable Header. If a future 0.3.x ever stops deriving Clone on Header,
        // construct it field-by-field instead:
        // Header { compression, version, stage_size, frame_rate, num_frames }.
        let header = swf.header.swf_header().clone();
        let mut out = Vec::new();
        swf::write_swf(&header, &swf.tags, &mut out).map_err(|e| err("write", e))?;
        Ok(out)
    })
}

// --- Milestone 3 (NOT implemented yet) --------------------------------------
// Replace one bitmap character in place:
//
// #[wasm_bindgen]
// pub fn replace_bitmap(swf_bytes: &[u8], character_id: u16, png_bytes: &[u8]) -> Result<Vec<u8>, JsValue>
//
// Notes for the implementer:
// - Match `Tag::DefineBits{ id, .. } | DefineBitsJpeg2{ id, .. }`
//   `| DefineBitsJpeg3(v) if v.id == .. | DefineBitsLossless(v) if …`.
// - PNG → re-encode into the SAME variant where possible; JPEG3 keeps its
//   separate alpha channel; shared `JpegTables` must be preserved.
// - Then `write_swf(header, &tags, …)` exactly like `roundtrip` above.
//
// Move one sprite instance:
//
// #[wasm_bindgen]
// pub fn set_place_matrix(swf_bytes: &[u8], depth: u16, _matrix_json: &str) -> Result<Vec<u8>, JsValue>
//
// Notes: match `Tag::PlaceObject(p)` (v1) and PlaceObject2/3/4, including
// inside nested `Tag::DefineSprite(s)` timelines; patch `p.matrix`.
