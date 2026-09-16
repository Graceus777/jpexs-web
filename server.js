// jpexs-web v0.1 — offline-first wrapper around local FFDec CLI.
// Run: npm install ; npm start  -> http://localhost:3000
// Requires: Java + FFDec installed. Set FFDEC_BIN if installed elsewhere.
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { installCostume } = require("./costume");

const PORT = process.env.PORT || 3000;
const FFDEC_BIN =
  process.env.FFDEC_BIN || "C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe";
const WORK_DIR = process.env.WORK_DIR || path.join(__dirname, "work");

fs.mkdirSync(WORK_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: path.join(WORK_DIR, "_tmp"),
  limits: { fileSize: 500 * 1024 * 1024 }, // SWF mods can be big
});
fs.mkdirSync(path.join(WORK_DIR, "_tmp"), { recursive: true });

function runFfdec(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const useShell = FFDEC_BIN.toLowerCase().endsWith(".bat");
    execFile(
      FFDEC_BIN,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 120000, shell: useShell, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function swfPaths(id) {
  const dir = path.join(WORK_DIR, id);
  return {
    dir,
    original: path.join(dir, "original.swf"),
    current: path.join(dir, "current.swf"),
    exports: path.join(dir, "exports"),
  };
}

function safeId(id) {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id) ? id : null;
}

// Walk a dir, return relative file list (cap at 2000 entries, 200 chars names)
function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    if (out.length > 2000) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full);
        const st = fs.statSync(full);
        out.push({ path: rel.replace(/\\/g, "/"), bytes: st.size });
        if (out.length > 2000) return;
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Best-effort fresh directory — never throws. Windows routinely refuses
// recursive delete (locked previews, AV/indexer handles, read-only files
// from FFDec). Fallbacks: chmod+retry, then move-aside + fresh dir with
// background cleanup, then file-by-file clear.
function resetDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`resetDir: rm failed for ${dir} (${e.code || e.message}), trying chmod+retry`);
    try {
      // read-only files are a classic Windows EPERM cause
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const en of entries) {
          const full = path.join(cur, en.name);
          try {
            if (en.isDirectory()) stack.push(full);
            else fs.chmodSync(full, 0o666);
          } catch {}
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e2) {
      console.error(`resetDir: retry failed (${e2.code || e2.message}), moving aside`);
      try {
        const aside = dir + ".old-" + Date.now().toString(36);
        fs.renameSync(dir, aside);
        setTimeout(() => { try { fs.rmSync(aside, { recursive: true, force: true }); } catch {} }, 10000);
      } catch (e3) {
        console.error(`resetDir: move-aside failed (${e3.code || e3.message}), clearing file-by-file`);
        try {
          for (const en of fs.readdirSync(dir)) {
            try {
              const full = path.join(dir, en);
              if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
              else fs.unlinkSync(full);
            } catch {}
          }
        } catch {}
      }
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`resetDir: mkdir failed for ${dir} (${e.code || e.message})`);
  }
}

installCostume(app, { workDir: WORK_DIR, runFfdec, listFilesRecursive });

// --- API ---

app.get("/api/health", async (req, res) => {
  let ffdec = null;
  try {
    const r = await runFfdec(["-help"]);
    ffdec = r.stdout.split("\n").slice(0, 3).join(" ").slice(0, 200);
  } catch (e) {
    ffdec = "ERROR: " + (e.stderr || e.message || e).toString().slice(0, 500);
  }
  res.json({ ok: true, ffdecBin: FFDEC_BIN, ffdec, workDir: WORK_DIR });
});

// Upload a SWF, returns { id }
app.post("/api/swf", upload.single("swf"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing 'swf' file" });
  const id =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const p = swfPaths(id);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.renameSync(req.file.path, p.original);
  fs.copyFileSync(p.original, p.current);
  res.json({ id, bytes: fs.statSync(p.current).size });
});

// Raw tag dump (passthrough text — UI parses visually for now)
app.get("/api/swf/:id/tags", async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  const p = swfPaths(id);
  if (!fs.existsSync(p.current))
    return res.status(404).json({ error: "swf not found" });
  try {
    const r = await runFfdec(["-dumpSWF", p.current]);
    res.json({ raw: r.stdout });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stdout: e.stdout, stderr: e.stderr });
  }
});

// Export assets: { types: "image,sound,script,sprite,shape,frame,button,movie,font,text,binaryData" }
app.post("/api/swf/:id/export", async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  const p = swfPaths(id);
  if (!fs.existsSync(p.current))
    return res.status(404).json({ error: "swf not found" });
  const types = String(req.body.types || "sprite").replace(/[^a-zA-Z,]/g, "");
  resetDir(p.exports); // never throws (Windows file locks must not kill the server)
  try {
    const r = await runFfdec(["-export", types, p.exports, p.current]);
    const files = listFilesRecursive(p.exports);
    res.json({ types, count: files.length, files, log: (r.stdout + r.stderr).slice(0, 4000) });
  } catch (e) {
    res.status(500).json({ error: String(e.message), stdout: e.stdout, stderr: e.stderr });
  }
});

// Serve exported files
app.get("/api/swf/:id/files/*", (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).send("bad id");
  const p = swfPaths(id);
  const rel = req.params[0] || "";
  const full = path.normalize(path.join(p.exports, rel));
  if (!full.startsWith(p.exports)) return res.status(400).send("bad path");
  if (!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

// Replace one character/script: multipart fields: target (charId or scriptName), file
// e.g. target=5 + PNG for image/char 5; target=com.example.Class + .as for AS3
app.post("/api/swf/:id/replace", upload.single("file"), async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: "bad id" });
  const target = String(req.body.target || "").trim();
  if (!target) return res.status(400).json({ error: "missing 'target' (characterId or scriptName)" });
  if (!req.file) return res.status(400).json({ error: "missing 'file'" });
  const p = swfPaths(id);
  if (!fs.existsSync(p.current))
    return res.status(404).json({ error: "swf not found" });
  const format = String(req.body.format || "").trim(); // optional: lossless, jpeg3...
  const tmpOut = path.join(p.dir, "current.next.swf");
  const args = ["-replace", p.current, tmpOut, target, req.file.path];
  if (format) args.push(format);
  try {
    const r = await runFfdec(args);
    fs.renameSync(tmpOut, p.current);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, bytes: fs.statSync(p.current).size, log: (r.stdout + r.stderr).slice(0, 4000) });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
    res.status(500).json({ error: String(e.message), stdout: e.stdout, stderr: e.stderr });
  }
});

// Download current working SWF
app.get("/api/swf/:id/download", (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).send("bad id");
  const p = swfPaths(id);
  if (!fs.existsSync(p.current)) return res.status(404).send("not found");
  res.download(p.current, `mod-${id}.swf`);
});

app.listen(PORT, () => {
  console.log(`jpexs-web listening on http://localhost:${PORT}`);
  console.log(`FFDEC_BIN=${FFDEC_BIN}`);
});
