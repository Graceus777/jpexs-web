# wasm/ — browser-native SWF layer (Ruffle `swf` crate → WASM)

## Status: Milestone 2 SHIPPED ✅

`public/wasm-pkg/` (`swf_tools.js` + `swf_tools_bg.wasm`, ~365 KB) is built
from this crate and **committed** so static hosts serve it with zero CI.
The page auto-loads it (`SWFClient.ensureWasm()`) and falls back to the
pure-JS walker when it can't load (file://, offline).

Exports: `inspect(bytes) -> JSON string` (version, numeric frameRate,
numFrames, as3, tags with full `Debug`), `roundtrip(bytes) -> Uint8Array`
(write-path smoke test; tag-identity preserved, byte-identity not).

Verified: `cargo check` clean on rustc 1.98.1; 11/11 Node tests against the
shipped artifact (FWS + CWS inspect, roundtrip tag-identity, garbage rejected).
One real crate fact the tests caught: `read_tag_list` consumes `End` as
terminator WITHOUT pushing it, so `numTags` counts real tags only.

## Toolchain (one-time, already done on this machine)

```powershell
winget install Rustlang.Rustup   # then reopen the shell
rustup target add wasm32-unknown-unknown
# wasm-pack: prebuilt binary (much faster than `cargo install wasm-pack`):
# https://github.com/rustwasm/wasm-pack/releases → *-x86_64-pc-windows-msvc.tar.gz
```

Host linking (proc-macros) needs MSVC + Windows SDK on PATH — VS 18
BuildTools + SDK 10.0.26100.0 are installed here; see the build transcript
in chat history for the exact `$env:INCLUDE` / `$env:LIB` lines if a fresh
shell ever fails to link.

## Build

```powershell
wasm-pack build wasm --target web --release --out-dir ../public/wasm-pkg --out-name swf_tools
Remove-Item public\wasm-pkg\.gitignore   # wasm-pack regenerates a `*` ignore; we commit the build
```

## Use from the page

Don't raw-import the glue — go through `SWFClient`:

```js
if (await SWFClient.ensureWasm()) {
  const info = SWFClient.inspectWasm(bytes);   // { engine:"wasm", signature, compression, version, frameRate, frameCount, as3, numTags, tags }
  text = SWFClient.summarizeWasm(info);
  const rewritten = SWFClient.roundtripWasm(bytes);
} else {
  const info = await SWFClient.parseLocal(bytes); // JS fallback (no ZWS/LZMA)
}
```

ZWS/LZMA now works via WASM (pure-Rust `lzma-rs`, no backend needed).

## Pinned API (verified vs docs.rs/swf 0.3.0)

- `swf::decompress_swf(&bytes[..]) -> Result<SwfBuf>`
- `swf::parse_swf(&buf) -> Result<Swf { header: HeaderExt, tags: Vec<Tag> }>`
- `HeaderExt::{version, frame_rate, num_frames, is_action_script_3, swf_header}`
- `swf::write_swf(&Header, &[Tag], writer)`
- Tag codes: see `swf::TagCode` (End=0 … PlaceObject4=94); the JS map in
  `swf-client.js` mirrors it exactly.

## Roadmap

- M3a `replace_bitmap(swf, character_id, png)` — same-variant re-encode,
  preserve `JpegTables` + JPEG3 alpha.
- M3b `set_place_matrix(swf, depth, matrix)` incl. nested `DefineSprite` timelines.
- Then: static-only deploy (GitHub/Cloudflare Pages, ~$0), FFDec kept as
  `advanced (local backend)` for shapes/SVG/AS3/edge cases.
