const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const multer = require("multer");

function prepareCostume(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3"),
      [path.join(__dirname, "clipper", "prepare.py"), ...args],
      { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.validation = error.code === 2;
          error.detail = stderr;
          return reject(error);
        }
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
  });
}

function installCostume(app, { workDir, runFfdec, listFilesRecursive, prepare = prepareCostume }) {
  const upload = multer({
    dest: path.join(workDir, "_tmp"),
    limits: { fileSize: 20 * 1024 * 1024, files: 2, fields: 10, parts: 10, fieldSize: 100 },
  }).fields([{ name: "image", maxCount: 1 }, { name: "mask", maxCount: 1 }]);
  let busy = false;
  app.post("/api/costume", (req, res) => {
    if (busy) return res.status(503).set("Retry-After", "10").json({ error: "The clipper is busy. Try again shortly." });
    busy = true;
    upload(req, res, async uploadError => {
      let dir;
      let complete = false;
      try {
        if (uploadError) return res.status(uploadError.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Upload one image and one PNG mask, each at most 20 MB." });
        const image = req.files?.image?.[0];
        const mask = req.files?.mask?.[0];
        const extraKeys = Object.keys(req.body || {}).filter(key => key !== "modtype" && key !== "overfitPx");
        const modtype = req.body.modtype;
        const hasOverfit = req.body.overfitPx !== undefined;
        const rawOverfit = hasOverfit ? req.body.overfitPx : "4";
        if (!image || !mask || extraKeys.length || typeof modtype !== "string" || (hasOverfit && typeof rawOverfit !== "string")) {
          return res.status(400).json({ error: "Upload one image and one PNG mask, each at most 20 MB." });
        }
        if (!["TOP", "BOTTOMS"].includes(modtype) || !/^\d{1,2}$/.test(rawOverfit) || Number(rawOverfit) > 20) {
          return res.status(400).json({ error: "Provide image, mask, modtype TOP or BOTTOMS, and overfitPx from 0 to 20." });
        }
        const id = randomUUID();
        dir = path.join(workDir, id);
        fs.mkdirSync(dir, { recursive: true });
        const prepared = await prepare(["--image", image.path, "--mask", mask.path,
          "--modtype", modtype, "--overfit-px", String(Number(rawOverfit)), "--output", dir]);
        const template = path.join(__dirname, "clipper", "template", modtype === "TOP" ? "top_static.swf" : "bot_static.swf");
        const current = path.join(dir, "current.swf");
        await runFfdec(["-importImages", template, current, path.join(dir, "images")]);
        const fd = fs.openSync(current, "r");
        const signature = Buffer.alloc(3);
        try { fs.readSync(fd, signature, 0, 3, 0); } finally { fs.closeSync(fd); }
        if (!["FWS", "CWS", "ZWS"].includes(signature.toString())) throw new Error("Invalid compiled SWF");
        fs.copyFileSync(current, path.join(dir, "original.swf"));
        complete = true;
        const exports = path.join(dir, "exports");
        fs.mkdirSync(exports);
        const result = { id, bytes: fs.statSync(current).size, regions: prepared.regions, types: "image", files: [], count: 0 };
        try {
          await runFfdec(["-export", "image", exports, current]);
          result.files = listFilesRecursive(exports);
          result.count = result.files.length;
        } catch (error) {
          console.error("Costume export failed:", error.message);
          result.exportError = "SWF created, but asset export failed. Use Export to retry.";
        }
        res.status(201).json(result);
      } catch (error) {
        console.error("Costume conversion failed:", error.message, error.detail || "");
        res.status(error.validation ? 422 : 500).json({ error: error.validation
          ? "Image or mask is invalid, empty, or does not overlap the selected template regions. Use an aligned PNG/JPEG/WebP up to 4096 pixels per side and 16 MP, and a PNG selection mask."
          : "Costume conversion failed. Check the server's Python/Pillow and FFDec installation, then retry." });
      } finally {
        for (const file of Object.values(req.files || {}).flat()) {
          try { fs.unlinkSync(file.path); } catch {}
        }
        if (dir) {
          try { fs.rmSync(complete ? path.join(dir, "images") : dir, { recursive: true, force: true }); } catch {}
        }
        busy = false;
      }
    });
  });
}

module.exports = { installCostume, prepareCostume };
