const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const multer = require("multer");

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const THROUGHPUT_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOBS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

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

function installCostume(app, { workDir, runFfdec, listFilesRecursive, prepare = prepareCostume, now = Date.now }) {
  const tmpDir = path.join(workDir, "_tmp");
  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 20 * 1024 * 1024, files: 2, fields: 10, parts: 10, fieldSize: 100 },
  }).fields([{ name: "image", maxCount: 1 }, { name: "mask", maxCount: 1 }]);

  // Drop staged uploads orphaned by a previous crash. Multer only writes files
  // directly into _tmp, so any subdirectory here is ours.
  try {
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.rmSync(path.join(tmpDir, entry.name), { recursive: true, force: true });
    }
  } catch {}

  const jobs = new Map();
  let active = null;

  function queueStats() {
    const t = now();
    let pending = 0, retained = 0, completedLast5Min = 0;
    for (const job of jobs.values()) {
      if (job.status === "queued") pending++;
      if (job.finishedAt && t - job.finishedAt < JOB_TTL_MS) {
        retained++;
        if (t - job.finishedAt < THROUGHPUT_WINDOW_MS) completedLast5Min++;
      }
    }
    return { active: active ? 1 : 0, pending, completedLast5Min, retained24h: retained };
  }

  function prune() {
    const t = now();
    for (const [id, job] of jobs) {
      if (job !== active && job.finishedAt && t - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
    }
    while (jobs.size > MAX_JOBS) {
      const oldest = [...jobs.values()].find(job => job !== active && job.finishedAt);
      if (!oldest) break;
      jobs.delete(oldest.jobId);
    }
  }

  function positionOf(job) {
    if (job.status !== "queued") return 0;
    let position = active ? 2 : 1;
    for (const other of jobs.values()) {
      if (other === job) break;
      if (other.status === "queued") position++;
    }
    return position;
  }

  function describe(job) {
    const view = {
      jobId: job.jobId, status: job.status, position: positionOf(job),
      createdAt: job.createdAt, queue: queueStats(),
    };
    if (job.startedAt) view.startedAt = job.startedAt;
    if (job.finishedAt) view.finishedAt = job.finishedAt;
    if (job.result) view.result = job.result;
    if (job.error) view.error = job.error;
    return view;
  }

  async function runJob(job) {
    const dir = path.join(workDir, job.swfId);
    fs.mkdirSync(dir, { recursive: true });
    let complete = false;
    try {
      const prepared = await prepare(["--image", job.imagePath, "--mask", job.maskPath,
        "--modtype", job.modtype, "--overfit-px", job.overfitPx, "--output", dir]);
      const template = path.join(__dirname, "clipper", "template", job.modtype === "TOP" ? "top_static.swf" : "bot_static.swf");
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
      const result = { id: job.swfId, bytes: fs.statSync(current).size, regions: prepared.regions, types: "image", files: [], count: 0 };
      try {
        await runFfdec(["-export", "image", exports, current]);
        result.files = listFilesRecursive(exports);
        result.count = result.files.length;
      } catch (error) {
        console.error("Costume export failed:", error.message);
        result.exportError = "SWF created, but asset export failed. Use Export to retry.";
      }
      return result;
    } finally {
      try { fs.rmSync(job.stage, { recursive: true, force: true }); } catch {}
      if (complete) {
        try { fs.rmSync(path.join(dir, "images"), { recursive: true, force: true }); } catch {}
      } else {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  function pump() {
    if (active) return;
    const next = [...jobs.values()].find(job => job.status === "queued");
    if (!next) return;
    active = next;
    next.status = "processing";
    next.startedAt = now();
    runJob(next).then(
      result => { next.status = "done"; next.result = result; },
      error => {
        console.error("Costume conversion failed:", error.message, error.detail || "");
        next.status = "error";
        next.error = error.validation
          ? { code: 422, message: "Image or mask is invalid, empty, or does not overlap the selected template regions. Use an aligned PNG/JPEG/WebP up to 4096 pixels per side and 16 MP, and a PNG selection mask." }
          : { code: 500, message: "Costume conversion failed. Check the server's Python/Pillow and FFDec installation, then retry." };
      }
    ).finally(() => {
      next.finishedAt = now();
      active = null;
      prune();
      setImmediate(pump);
    });
  }

  app.post("/api/costume", (req, res) => {
    upload(req, res, uploadError => {
      prune();
      if (uploadError) return res.status(uploadError.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Upload one image and one PNG mask, each at most 20 MB." });
      const cleanupUploads = () => {
        for (const file of Object.values(req.files || {}).flat()) {
          try { fs.unlinkSync(file.path); } catch {}
        }
      };
      const image = req.files?.image?.[0];
      const mask = req.files?.mask?.[0];
      const extraKeys = Object.keys(req.body || {}).filter(key => key !== "modtype" && key !== "overfitPx");
      const modtype = req.body.modtype;
      const hasOverfit = req.body.overfitPx !== undefined;
      const rawOverfit = hasOverfit ? req.body.overfitPx : "4";
      if (!image || !mask || extraKeys.length || typeof modtype !== "string" || (hasOverfit && typeof rawOverfit !== "string")) {
        cleanupUploads();
        return res.status(400).json({ error: "Upload one image and one PNG mask, each at most 20 MB." });
      }
      if (!["TOP", "BOTTOMS"].includes(modtype) || !/^\d{1,2}$/.test(rawOverfit) || Number(rawOverfit) > 20) {
        cleanupUploads();
        return res.status(400).json({ error: "Provide image, mask, modtype TOP or BOTTOMS, and overfitPx from 0 to 20." });
      }
      const job = {
        jobId: randomUUID(), swfId: randomUUID(), status: "queued", createdAt: now(),
        stage: path.join(tmpDir, randomUUID()),
        modtype, overfitPx: String(Number(rawOverfit)),
      };
      job.imagePath = path.join(job.stage, "image");
      job.maskPath = path.join(job.stage, "mask");
      try {
        fs.mkdirSync(job.stage, { recursive: true });
        fs.renameSync(image.path, job.imagePath);
        fs.renameSync(mask.path, job.maskPath);
      } catch (error) {
        cleanupUploads();
        try { fs.rmSync(job.stage, { recursive: true, force: true }); } catch {}
        return res.status(500).json({ error: "Could not stage uploads. Try again shortly." });
      }
      jobs.set(job.jobId, job);
      pump();
      res.status(202).json(describe(job));
    });
  });

  app.get("/api/costume/queue", (req, res) => {
    prune();
    res.json(queueStats());
  });

  app.get("/api/costume/jobs/:jobId", (req, res) => {
    prune();
    if (!ID_PATTERN.test(req.params.jobId)) return res.status(400).json({ error: "bad job id" });
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job unknown or expired (results are kept 24 hours)" });
    res.json(describe(job));
  });
}

module.exports = { installCostume, prepareCostume };
