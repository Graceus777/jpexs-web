# wasm/ — browser-native SWF layer (Ruffle `swf` crate → WASM)

## What this is

Milestone 1 (shipped, no toolchain): `public/swf-client.js` parses FWS/CWS
headers + tag lists in pure JS and previews via the Ruffle CDN player.

This crate is Milestone 2: the same `swf` 0.3.x parser Ruffle itself uses,
compiled to WASM so the page gets full tag models (`Matrix`,
`ColorTransform`, sprite timelines) plus `write_swf` for Milestone 3
(bitmap / `PlaceObject` writes, then the site goes fully static).

## Toolchain (one-time)

```powershell
winget install Rustlang.Rustup
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

This repo's dev machine has Node 24 but no Rust yet — that only matters for
building this crate; the page runs fine without it (local JS + FFDec fallback).

## Build

```powershell
cd wasm
wasm-pack build --target web --out-dir ../public/wasm-pkg
```

That generates `public/wasm-pkg/` (`swf_tools.js` + `.wasm` glue).
The directory is git-ignored build output; Pages/Vercel serve it as static files.

## Use from the page

```js
import init, { inspect, roundtrip } from "./wasm-pkg/swf_tools.js";
await init();
const summary = JSON.parse(inspect(swfBytes)); // replaces/augments SWFClient.parseLocal
const rewritten = roundtrip(swfBytes);          // write-path smoke test
```

Wire-in point: `public/swf-client.js` — try `inspect()` when
`wasm-pkg/` loads, fall back to `parseLocal()` offline, fall back to
`/api/swf/:id/tags` (FFDec) for ZWS/LZMA and AS3 work.

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
