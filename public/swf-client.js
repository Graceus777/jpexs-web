/* jpexs-web — browser-native SWF helpers (Milestones 1+2).
 *
 * No dependencies. Works from file:// and any static host (GitHub/Cloudflare Pages).
 * - SWFClient.parseLocal(bytes): pure-JS SWF header + tag walker.
 *   Handles FWS (none) + CWS (zlib). ZWS (LZMA) is rejected with a clear error
 *   (needs the WASM engine below). Tag names follow Ruffle `swf` crate 0.3.0 TagCode.
 * - SWFClient.ensureWasm()/inspectWasm()/roundtripWasm(): optional upgrade backed
 *   by the real Ruffle `swf` crate compiled to WASM (see wasm/, ships in wasm-pkg/).
 *   Full tag decode + AS3 flag + LZMA. Graceful: falls back to parseLocal() when
 *   the .wasm can't load (file://, offline, old browser).
 * - Ruffle preview helpers (need the @ruffle-rs/ruffle CDN script; degrade gracefully).
 * - USE_LOCAL_PARSER flag persisted in localStorage ("jpexs.useLocal" = "1"/"0").
 *
 * In Node (tests) this file exports via module.exports.
 */
"use strict";

(function (root) {
  // Exact TagCode map from Ruffle `swf` crate 0.3.0 (docs.rs/swf TagCode).
  const TAG_NAMES = {
    0: "End", 1: "ShowFrame", 2: "DefineShape", 4: "PlaceObject",
    5: "RemoveObject", 6: "DefineBits", 7: "DefineButton", 8: "JPEGTables",
    9: "SetBackgroundColor", 10: "DefineFont", 11: "DefineText", 12: "DoAction",
    13: "DefineFontInfo", 14: "DefineSound", 15: "StartSound",
    17: "DefineButtonSound", 18: "SoundStreamHead", 19: "SoundStreamBlock",
    20: "DefineBitsLossless", 21: "DefineBitsJPEG2", 22: "DefineShape2",
    23: "DefineButtonCxform", 24: "Protect", 26: "PlaceObject2",
    28: "RemoveObject2", 32: "DefineShape3", 33: "DefineText2",
    34: "DefineButton2", 35: "DefineBitsJPEG3", 36: "DefineBitsLossless2",
    37: "DefineEditText", 39: "DefineSprite", 40: "NameCharacter",
    41: "ProductInfo", 43: "FrameLabel", 45: "SoundStreamHead2",
    46: "DefineMorphShape", 48: "DefineFont2", 56: "ExportAssets",
    57: "ImportAssets", 58: "EnableDebugger", 59: "DoInitAction",
    60: "DefineVideoStream", 61: "VideoFrame", 62: "DefineFontInfo2",
    63: "DebugId", 64: "EnableDebugger2", 65: "ScriptLimits",
    66: "SetTabIndex", 69: "FileAttributes", 70: "PlaceObject3",
    71: "ImportAssets2", 72: "DoABC", 73: "DefineFontAlignZones",
    74: "CSMTextSettings", 75: "DefineFont3", 76: "SymbolClass",
    77: "Metadata", 78: "DefineScalingGrid", 82: "DoABC2",
    83: "DefineShape4", 84: "DefineMorphShape2",
    86: "DefineSceneAndFrameLabelData", 87: "DefineBinaryData",
    88: "DefineFontName", 89: "StartSound2", 90: "DefineBitsJPEG4",
    91: "DefineFont4", 93: "EnableTelemetry", 94: "PlaceObject4",
  };

  function tagName(code) {
    return Object.prototype.hasOwnProperty.call(TAG_NAMES, code)
      ? TAG_NAMES[code]
      : "Unknown(" + code + ")";
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (root.Buffer && root.Buffer.isBuffer && root.Buffer.isBuffer(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.length);
    }
    throw new Error("parseLocal expects Uint8Array, ArrayBuffer, or Buffer");
  }

  async function inflateZlib(u8) {
    // Browser path: DecompressionStream("deflate") handles the zlib wrapper.
    if (typeof root.DecompressionStream === "function") {
      const ds = new root.DecompressionStream("deflate");
      const stream = new root.Blob([u8]).stream().pipeThrough(ds);
      const buf = await new root.Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    // Node fallback (tests / SSR): built-in zlib, no dependency.
    if (typeof require === "function") {
      const zlib = require("zlib");
      const out = zlib.inflateSync(root.Buffer.from(u8));
      return new Uint8Array(out.buffer, out.byteOffset, out.length);
    }
    throw new Error("no zlib backend: use a modern browser or Node 18+");
  }

  // Bit reader for the SWF RECT (stage size): 5-bit nbits, then 4x signed nbits.
  function parseRect(d, off) {
    let bitPos = off * 8;
    const totalBits = d.length * 8;
    function readBits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) {
        if (bitPos >= totalBits) throw new Error("truncated RECT");
        const byte = d[bitPos >> 3];
        const bit = (byte >> (7 - (bitPos & 7))) & 1;
        v = (v << 1) | bit;
        bitPos++;
      }
      return v;
    }
    function readSBits(n) {
      if (n === 0) return 0;
      const v = readBits(n);
      return v & (1 << (n - 1)) ? v - (1 << n) : v;
    }
    const nbits = readBits(5);
    const xMin = readSBits(nbits);
    const xMax = readSBits(nbits);
    const yMin = readSBits(nbits);
    const yMax = readSBits(nbits);
    const endOff = Math.ceil(bitPos / 8);
    const twip = (t) => t / 20;
    return {
      xMinTw: xMin, xMaxTw: xMax, yMinTw: yMin, yMaxTw: yMax,
      xMinPx: twip(xMin), xMaxPx: twip(xMax),
      yMinPx: twip(yMin), yMaxPx: twip(yMax),
      widthPx: twip(xMax - xMin), heightPx: twip(yMax - yMin),
      bytesRead: endOff - off,
    };
  }

  function walkTags(d, startPos) {
    const tags = [];
    let pos = startPos;
    let truncated = false;
    let index = 0;
    while (pos + 2 <= d.length) {
      const hdr = d[pos] | (d[pos + 1] << 8);
      const code = hdr >> 6;
      let len = hdr & 0x3f;
      const hdrOff = pos;
      pos += 2;
      if (len === 0x3f) {
        if (pos + 4 > d.length) { truncated = true; break; }
        len = (d[pos] | (d[pos + 1] << 8) | (d[pos + 2] << 16) | (d[pos + 3] << 24)) >>> 0;
        pos += 4;
      }
      tags.push({ index: index++, code, name: tagName(code), length: len, offset: pos, headerOffset: hdrOff });
      pos += len;
      if (pos > d.length) { truncated = true; break; }
      if (code === 0) break; // End
      if (tags.length > 20000) { truncated = true; break; }
    }
    return { tags, truncated };
  }

  function summarizeCounts(tags) {
    const counts = Object.create(null);
    for (const t of tags) counts[t.name] = (counts[t.name] || 0) + 1;
    return counts;
  }

  /**
   * Parse an SWF file fully client-side. Returns:
   * { signature, compression, version, fileLength, frameRate, frameCount,
   *   stage, numTags, tags[{index,code,name,length,offset}], counts, truncated, warning }
   */
  async function parseLocal(input) {
    const bytes = toBytes(input);
    if (bytes.length < 8) throw new Error("too short for an SWF header (need 8+ bytes)");
    const sig =
      String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    const version = bytes[3];
    const fileLength =
      bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    let body;
    let compression;
    let warning = null;
    if (sig === "FWS") {
      compression = "none";
      body = bytes.slice(8);
    } else if (sig === "CWS") {
      compression = "zlib";
      body = await inflateZlib(bytes.slice(8));
    } else if (sig === "ZWS") {
      throw new Error(
        "LZMA-compressed SWF (ZWS): needs the WASM build (see wasm/). " +
        "Re-save as zlib-compressed, or use the local FFDec backend for this file."
      );
    } else {
      throw new Error("not an SWF (bad signature " + JSON.stringify(sig) + ")");
    }
    const rect = parseRect(body, 0);
    let pos = rect.bytesRead;
    if (pos + 4 > body.length) throw new Error("truncated SWF (missing frameRate/frameCount)");
    const frameRateRaw = body[pos] | (body[pos + 1] << 8);
    const frameCount = body[pos + 2] | (body[pos + 3] << 8);
    pos += 4;
    const { tags, truncated } = walkTags(body, pos);
    if (truncated) {
      warning = "tag stream looks truncated (declared lengths run past EOF)";
    }
    return {
      signature: sig,
      compression,
      version,
      fileLength: fileLength >>> 0,
      frameRate: frameRateRaw / 256,
      frameCount,
      stage: rect,
      numTags: tags.length,
      tags,
      counts: summarizeCounts(tags),
      truncated,
      warning,
    };
  }

  function shortSummary(info, maxTags) {
    const lines = [];
    lines.push(
      "[local] SWF v" + info.version + " " + info.signature +
      " (" + info.compression + "), " +
      info.frameCount + " frame(s) @ " + info.frameRate + "fps, " +
      info.numTags + " tag(s), stage " +
      info.stage.widthPx.toFixed(0) + "x" + info.stage.heightPx.toFixed(0) + "px"
    );
    const names = Object.keys(info.counts).sort();
    lines.push("[local] counts: " + names.map((n) => n + "x" + info.counts[n]).join(" "));
    const n = Math.min(maxTags == null ? 60 : maxTags, info.tags.length);
    for (let i = 0; i < n; i++) {
      const t = info.tags[i];
      lines.push("  #" + t.index + " " + t.name + " (code " + t.code + ", " + t.length + "B)");
    }
    if (info.tags.length > n) lines.push("  … +" + (info.tags.length - n) + " more");
    if (info.warning) lines.push("[local] warning: " + info.warning);
    return lines.join("\n");
  }

  // ---- WASM engine (Ruffle `swf` crate 0.3 via wasm-pack; see wasm/) ----
  // Optional upgrade over parseLocal: full tag decode (not just headers),
  // AS3 detection, and ZWS/LZMA support. Loads from `wasm-pkg/` next to this
  // file. Anything can fail here (file://, offline, old browser) — callers
  // must fall back to parseLocal(). Never throws on import in Node either:
  // loadWasm() simply reports "missing" outside a DOM.
  const wasm = { status: "unloaded", error: "", mod: null };
  function wasmStatus() { return wasm.status; }
  function wasmError() { return wasm.error; }
  function defaultWasmBase() {
    try {
      if (root.document && root.location) {
        const scripts = root.document.querySelectorAll('script[src*="swf-client.js"]');
        if (scripts.length) {
          const u = new URL(scripts[scripts.length - 1].getAttribute("src"), root.location.href);
          return u.pathname.slice(0, u.pathname.lastIndexOf("/")) + "/wasm-pkg";
        }
      }
    } catch { /* fall through to relative default */ }
    return "wasm-pkg";
  }
  async function loadWasm(base) {
    if (wasm.status === "ready") return true;
    if (wasm.status === "loading") return false;
    if (typeof window === "undefined" || !root.document) {
      wasm.status = "missing"; wasm.error = "no DOM (Node?)"; return false;
    }
    wasm.status = "loading";
    try {
      const rootPath = String(base || defaultWasmBase()).replace(/\/+$/, "");
      const mod = await import(rootPath + "/swf_tools.js");
      await mod.default(rootPath + "/swf_tools_bg.wasm");
      wasm.mod = mod;
      wasm.status = "ready";
      return true;
    } catch (e) {
      wasm.status = "failed";
      wasm.error = String((e && e.message) || e);
      return false;
    }
  }
  async function ensureWasm(base) {
    if (wasm.status === "ready") return true;
    if (wasm.status === "unloaded") return loadWasm(base);
    return false;
  }
  function needWasm() {
    if (!wasm.mod) throw new Error("WASM engine not loaded (" + wasm.status + (wasm.error ? ": " + wasm.error : "") + ")");
    return wasm.mod;
  }
  // inspectWasm(bytes) -> { engine, signature, compression, version,
  //   frameRate, frameCount, as3, numTags, tags[{index,kind,debug}] }.
  // Signature/compression come from the file header (the crate only reports
  // post-decompression facts); shape otherwise mirrors parseLocal() closely
  // enough that UI code can consume either.
  function inspectWasm(input) {
    const mod = needWasm();
    const bytes = toBytes(input);
    const sig = bytes.length >= 3
      ? String.fromCharCode(bytes[0], bytes[1], bytes[2]) : "???";
    const compression = sig === "FWS" ? "none" : sig === "CWS" ? "zlib" : sig === "ZWS" ? "lzma" : "unknown";
    const parsed = JSON.parse(mod.inspect(bytes));
    return {
      engine: "wasm",
      signature: sig,
      compression,
      version: parsed.version,
      frameRate: parsed.frameRate,
      frameCount: parsed.numFrames,
      as3: parsed.as3,
      numTags: parsed.numTags,
      tags: parsed.tags,
      truncated: false,
      warning: null,
    };
  }
  function summarizeWasm(info, maxTags) {
    const lines = [];
    lines.push(
      "[wasm] SWF v" + info.version + " " + info.signature +
      " (" + info.compression + ")" + (info.as3 ? " AS3" : "") + ", " +
      info.frameCount + " frame(s) @ " + info.frameRate + "fps, " +
      info.numTags + " tag(s) — full decode via swf crate 0.3"
    );
    const counts = Object.create(null);
    for (const t of info.tags) counts[t.kind] = (counts[t.kind] || 0) + 1;
    lines.push("[wasm] counts: " + Object.keys(counts).sort().map((n) => n + "x" + counts[n]).join(" "));
    const n = Math.min(maxTags == null ? 60 : maxTags, info.tags.length);
    for (let i = 0; i < n; i++) {
      const t = info.tags[i];
      const dbg = t.debug.length > 140 ? t.debug.slice(0, 140) + "…" : t.debug;
      lines.push("  #" + t.index + " " + t.kind + " :: " + dbg);
    }
    if (info.tags.length > n) lines.push("  … +" + (info.tags.length - n) + " more");
    return lines.join("\n");
  }
  // roundtripWasm(bytes) -> Uint8Array: parse → re-serialize via the crate.
  // Tag-identity preserved; byte-identity NOT guaranteed (writer normalizes
  // long-form tag headers). Write-path smoke test, not a mod tool (yet).
  function roundtripWasm(input) {
    const mod = needWasm();
    const out = mod.roundtrip(toBytes(input));
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  // ---- backend-mode flag ----
  const FLAG_KEY = "jpexs.useLocal";
  function getUseLocal() {
    try {
      const v = root.localStorage && root.localStorage.getItem(FLAG_KEY);
      return v == null ? true : v === "1"; // default ON: local-first
    } catch {
      return true;
    }
  }
  function setUseLocal(on) {
    try {
      if (root.localStorage) root.localStorage.setItem(FLAG_KEY, on ? "1" : "0");
    } catch { /* private mode: ignore */ }
  }

  // ---- Ruffle preview ----
  function ruffleApi() {
    const R = root.RufflePlayer;
    if (!R) return null;
    try {
      return R.newest ? R.newest() : R;
    } catch {
      return null;
    }
  }
  function isRuffleReady() {
    return !!ruffleApi();
  }
  function ensurePlayer(container) {
    const el = typeof container === "string"
      ? root.document.querySelector(container)
      : container;
    if (!el) throw new Error("preview container not found");
    const api = ruffleApi();
    if (!api) throw new Error("Ruffle CDN not loaded (offline?). Local inspect still works.");
    el.innerHTML = "";
    const player = api.createPlayer();
    player.style.width = "100%";
    player.style.height = "400px";
    player.style.display = "block";
    el.appendChild(player);
    return player;
  }
  async function previewBytes(container, input) {
    const bytes = toBytes(input);
    const player = ensurePlayer(container);
    const data = bytes.slice().buffer.slice
      ? bytes.slice()
      : new Uint8Array(bytes);
    await player.ruffle().load({ data });
    return player;
  }

  const SWFClient = {
    TAG_NAMES,
    tagName,
    parseLocal,
    shortSummary,
    wasmStatus,
    wasmError,
    loadWasm,
    ensureWasm,
    inspectWasm,
    summarizeWasm,
    roundtripWasm,
    getUseLocal,
    setUseLocal,
    FLAG_KEY,
    isRuffleReady,
    ensurePlayer,
    previewBytes,
    // set by the page: raw bytes of the last-picked / uploaded SWF.
    localBytes: null,
    localName: "",
  };

  root.SWFClient = SWFClient;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SWFClient;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
