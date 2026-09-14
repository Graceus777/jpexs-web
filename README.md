# jpexs-web — lightweight FFDec web client (offline-first)

Goal: decompile SWF flash mods (e.g. Super Deepthroat mods), **swap sprites/images in place,
swap audio, view/edit ActionScript**, then download the patched SWF. Lightweight enough for
community hosting.

Yes — ActionScript viewing/editing **is** a JPEXS function, and this preserves it:
export `script` → edit `.as` → `replace`/`importScript` back in.

## Run offline RIGHT NOW (Windows, your FFDec)

```powershell
cd C:\Users\throw\Github\jpexsWeb
npm install
npm start
# open http://localhost:3000
```

Requires Java (you have 1.8) + FFDec at `C:\Program Files (x86)\FFDec\ffdec-cli.exe`.
Override with: `$env:FFDEC_BIN="D:\path\to\ffdec-cli.exe"; npm start`

Workflow in the UI:
1. `Check FFDec` → health.
2. Upload `.swf` → you get an `id`.
3. `List tags` (dumpSWF) → find characterIds.
4. `Export` (`image,sound,script,sprite`) → preview sprites/audio, download `.as` scripts.
5. `Replace`: target = characterId (e.g. `5`) + your PNG/MP3, or script name
   (e.g. `com.example.MyClass`) + edited `.as` → rewrites `current.swf`.
6. Download patched SWF, test in Flash projector / Ruffle, iterate.

CLI equivalents (what the server runs for you):

```powershell
& "C:\Program Files (x86)\FFDec\ffdec.bat" -dumpSWF mod.swf
& "C:\Program Files (x86)\FFDec\ffdec.bat" -export image,sound,script,sprite .\out mod.swf
& "C:\Program Files (x86)\FFDec\ffdec.bat" -replace mod.swf mod2.swf 5 new.png
& "C:\Program Files (x86)\FFDec\ffdec.bat" -replace mod.swf mod2.swf com.example.Class fixed.as
```

## Can this go on Vercel?

Short answer: **frontend yes, FFDec backend no** — and that's the bit to learn:

- Vercel serverless functions run Node/Python, **no Java runtime**, ~50 MB bundle,
  ephemeral `/tmp`, 10–60 s timeout. FFDec is a Java CLI (`ffdec.jar` + `lib/`),
  routinely needs 100s of MB RAM and minutes on big SWFs. It won't fit/run there.
- So the learning path is: **static frontend on Vercel → API backend elsewhere**.
  `vercel.json` here deploys `public/` as a static site for learning; point its API
  base URL at your backend later.

Hosting options for community use:

| Option | Fits FFDec? | Notes |
|---|---|---|
| Vercel only | ❌ | Learn static deploy here, but no Java/FFDec |
| Local PC / LAN (this repo, `npm start`) | ✅ now | Zero cost, private, best for NSFW mods |
| Docker VPS (Hetzner/Contabo/Oracle) + this server | ✅ | `openjdk:17 + node`, persistent `work/` |
| Fly.io / Railway / Render (Docker) | ✅ | Easiest community host, set `FFDEC_BIN=/opt/ffdec/ffdec.sh` |
| Electron/Tauri wrapper | ✅ | Real desktop app reuse of this UI + bundled JRE |

## Split deploy (recommended for 24/7 community hosting)

One host can't do it all: Vercel/Cloudflare serverless has no Java runtime, so
FFDec (still the only write path — browser does inspect + preview only) needs
an always-on backend. Host the two halves separately:

- **Frontend (free):** Cloudflare Pages serving `public/` — $0, no bandwidth
  meter, 500 builds/mo. (Vercel static works too; Pages' unlimited bandwidth
  suits SWF-sized downloads better.)
- **Backend (pick one):**
  - **$0 — Oracle Always Free ARM** (2 OCPU / 12 GB after the June 2026 cut —
    still ~10x what `node` + FFDec needs). True 24/7, no sleep. Needs
    card/phone signup; A1 capacity can be scarce per region, so try nearby
    regions. Run the Dockerized `server.js` + FFDec here.
  - **$0 — home PC + Cloudflare Tunnel** (`cloudflared tunnel --url
    http://localhost:3000`): free, auto-HTTPS, no port forwarding. Uptime =
    your PC stays on. Fastest way to go public tonight.
  - **~€4–6/mo — Hetzner / Contabo VPS:** simplest real server, full control.
  - **~$6–8/mo — Fly.io 1 GB machine:** easiest deploys + free HTTPS, but no
    free tier for new accounts anymore (smallest shared is ~$2/mo at 256 MB,
    too small for Java — budget 1 GB).
  - **Render free: disqualified** — sleeps after 15 min idle + 30–50 s cold
    starts. Not 24/7.
- **Point the frontend at the backend:** open the page → *Backend + tags*
  card → paste the backend URL → **Use**. Stored in `localStorage`
  (`jpexs.apiBase`); empty = same-origin (local dev unchanged). **HTTPS rule:**
  an `https://` page can only call an `https://` backend — Tunnel/Fly give you
  this free; on a raw VPS put Caddy in front for auto-Let's-Encrypt.
- Keep uploads transient (server already uses per-`id` `work/` dirs, no
  accounts, nothing shared between users) and don't store other people's mods.

When the WASM writer (Milestone 3 in `wasm/`) lands, the common sprite-mod
path goes fully static and the backend shrinks to *advanced (FFDec) mode* for
shapes/SVG/AS3 — then hosting is ~$0 total.

Recommended: keep this repo as the **local/offline tool** (works today), deploy
`public/` to Vercel as a lesson, then Dockerize the same `server.js` + FFDec for
Fly.io when you want public community hosting. Ask to generate the `Dockerfile`
+ `fly.toml` next.

## Browser-native route (v0.3, local-first — no server needed for inspect/preview)

`public/` is now static-safe:

- Pick a `.swf` → **1b. Local inspect + live preview** parses the header + tag
  list entirely in-browser (`public/swf-client.js`, zero deps: FWS + CWS/zlib;
  ZWS/LZMA tells you to use FFDec or re-save as zlib). Tag names mirror Ruffle
  `swf` 0.3.0 `TagCode` exactly.
- **▶ Preview original** runs the file in Ruffle from CDN
  (`unpkg.com/@ruffle-rs/ruffle`); offline it degrades to inspect-only.
- **▶ Preview patched** fetches `current.swf` from your local backend when it's up.
- The **Tags** button is local-first: browser parse first, server `dumpSWF`
  appended when reachable. Unticked checkbox = old server-only behavior.
- Writes (export/replace) still go through FFDec on `localhost:3000` for now.

Next milestones live in `wasm/` (scaffolded, needs `rustup` + `wasm-pack` —
this machine has neither yet): compile the real Ruffle `swf` crate to WASM for
full tag models + `write_swf`, then implement just `replace_bitmap` and
`set_place_matrix`. At that point the common sprite-mod path is a static site
(GitHub/Cloudflare Pages, ~$0); FFDec stays as *advanced (local backend)* for
shapes/SVG/AS3/edge cases. See `wasm/README.md`.
