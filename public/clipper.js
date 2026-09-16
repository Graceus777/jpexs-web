"use strict";

(function () {
  const width = 1024, height = 1280, pixels = width * height;
  const canvas = $("#clipCanvas"), ctx = canvas.getContext("2d");
  const source = document.createElement("canvas"), overlay = document.createElement("canvas");
  source.width = overlay.width = width; source.height = overlay.height = height;
  const sourceCtx = source.getContext("2d"), overlayCtx = overlay.getContext("2d");
  const tint = overlayCtx.createImageData(width, height);
  let file = null, mask = new Uint8Array(pixels), history = [], stroke = null, selected = 0, frame = 0;
  const status = message => $("#clipStatus").textContent = message;

  function controls() {
    const ready = !!file && !jobBusy && !stroke;
    $("#clipProcess").disabled = !ready || !selected;
    $("#clipUndo").disabled = !ready || !history.length;
    $("#clipClear").disabled = !ready || !selected;
    $("#clipAll").disabled = !ready;
    $("#clipTool").disabled = !ready;
    $("#clipSize").disabled = !ready;
  }
  function render() {
    frame = 0;
    ctx.clearRect(0, 0, width, height);
    if (!file) return;
    ctx.drawImage(source, 0, 0);
    selected = 0;
    for (let i = 0; i < pixels; i++) {
      const j = i * 4;
      tint.data[j] = 0; tint.data[j + 1] = 190; tint.data[j + 2] = 255;
      tint.data[j + 3] = mask[i] ? 110 : 0;
      selected += mask[i];
    }
    overlayCtx.putImageData(tint, 0, 0); ctx.drawImage(overlay, 0, 0);
    controls();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  function remember(before) { history.push(before); if (history.length > 15) history.shift(); }
  function cancelStroke() {
    if (!stroke) return;
    const pointer = stroke.pointer;
    mask = stroke.before; stroke = null;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    render();
  }
  function resetSelection() {
    cancelStroke(); file = null; mask.fill(0); history = []; selected = 0;
    sourceCtx.clearRect(0, 0, width, height); ctx.clearRect(0, 0, width, height);
    canvas.hidden = true; canvas.style.display = "none"; $("#clipImage").value = "";
    status("Choose a templated image, then select the clothing."); controls();
  }
  function position(e) {
    const r = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width, (e.clientX - r.left) * width / r.width)),
      y: Math.max(0, Math.min(height, (e.clientY - r.top) * height / r.height)) };
  }
  function rectangle(a, b, value) {
    const left = Math.floor(Math.min(a.x, b.x)), right = Math.ceil(Math.max(a.x, b.x));
    const top = Math.floor(Math.min(a.y, b.y)), bottom = Math.ceil(Math.max(a.y, b.y));
    for (let y = top; y < bottom; y++) mask.fill(value, y * width + left, y * width + right);
  }
  function brush(a, b, value, size) {
    const radius = size / 2, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const left = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
    const right = Math.min(width, Math.ceil(Math.max(a.x, b.x) + radius));
    const top = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
    const bottom = Math.min(height, Math.ceil(Math.max(a.y, b.y) + radius));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const px = x + .5 - a.x, py = y + .5 - a.y;
        const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
        if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= radius * radius) mask[y * width + x] = value;
      }
    }
  }
  function advance(e) {
    const p = position(e);
    if (stroke.tool.startsWith("rect")) {
      mask.set(stroke.before); rectangle(stroke.start, p, stroke.value);
    } else brush(stroke.last, p, stroke.value, stroke.size);
    stroke.last = p; schedule();
  }
  canvas.addEventListener("pointerdown", e => {
    if (jobBusy || !file || stroke || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    const p = position(e), tool = $("#clipTool").value;
    stroke = { pointer: e.pointerId, start: p, last: p, before: mask.slice(), tool,
      size: Number($("#clipSize").value), value: tool.endsWith("add") ? 1 : 0 };
    try { canvas.setPointerCapture(e.pointerId); }
    catch { cancelStroke(); return; }
    if (tool.startsWith("brush")) brush(p, p, stroke.value, stroke.size);
    controls(); schedule();
  });
  canvas.addEventListener("pointermove", e => {
    if (!stroke || stroke.pointer !== e.pointerId || jobBusy) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const point of events.length ? events : [e]) advance(point);
  });
  canvas.addEventListener("pointerup", e => {
    if (!stroke || stroke.pointer !== e.pointerId) return;
    advance(e);
    const before = stroke.before; stroke = null; remember(before);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    render(); status(`${selected.toLocaleString()} selected pixels. Process compiles the selected ${$("#clipModtype").value} regions.`);
  });
  for (const event of ["pointercancel", "lostpointercapture"]) canvas.addEventListener(event, e => {
    if (stroke && stroke.pointer === e.pointerId) cancelStroke();
  });
  addEventListener("blur", cancelStroke);
  addEventListener("keydown", e => { if (e.key === "Escape") cancelStroke(); });
  document.addEventListener("jobbusy", cancelStroke);
  document.addEventListener("jobidle", controls);
  document.addEventListener("swfselected", resetSelection);
  async function refreshLoad() {
    const el = $("#clipLoad");
    try {
      const q = await requestJson(api("/api/costume/queue"));
      const bits = [q.active ? "1 compiling" : "idle"];
      if (q.pending) bits.push(`${q.pending} waiting`);
      bits.push(`${q.completedLast5Min || 0} done in last 5 min`);
      el.textContent = `Server load: ${bits.join(" · ")}`;
    } catch { el.textContent = "Server load: unavailable"; }
  }
  setInterval(() => { if (!document.hidden) refreshLoad(); }, 10000);
  refreshLoad();
  $("#clipSize").oninput = () => $("#clipSizeLabel").textContent = `${$("#clipSize").value} px`;
  $("#clipUndo").onclick = () => { if (jobBusy || stroke) return; if (history.length) mask = history.pop(); render(); };
  $("#clipClear").onclick = () => { if (jobBusy || stroke) return; remember(mask.slice()); mask.fill(0); render(); };
  $("#clipAll").onclick = () => { if (jobBusy || stroke || !file) return; remember(mask.slice()); mask.fill(1); render(); };

  $("#clipImage").onchange = async e => {
    const candidate = e.target.files[0];
    if (!candidate || !beginJob("Reading templated image locally...")) return;
    let url;
    try {
      resetJob(); resetSelection(); $("#swf").value = "";
      if (!candidate.size || candidate.size > 20 * 1024 * 1024) throw new Error("Image must be nonempty and no larger than 20 MB.");
      const header = new Uint8Array(await candidate.slice(0, 12).arrayBuffer());
      const png = [137,80,78,71,13,10,26,10].every((v, i) => header[i] === v);
      const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
      const webp = String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
      if (!png && !jpeg && !webp) throw new Error("Choose a PNG, JPEG or WebP image.");
      const image = new Image(); url = URL.createObjectURL(candidate); image.src = url;
      await image.decode();
      const w = image.naturalWidth, h = image.naturalHeight;
      if (!w || !h || w > 4096 || h > 4096 || w * h > 16000000) throw new Error("Image exceeds 4096 pixels per side or 16 megapixels.");
      sourceCtx.clearRect(0, 0, width, height); sourceCtx.drawImage(image, 0, 0, width, height);
      file = candidate; canvas.hidden = false; canvas.style.display = "block";
      render(); status(`${candidate.name}: ${w} x ${h}, normalized to 1024 x 1280. Drag to select clothing; cyan is included.`);
    } catch (e) { resetSelection(); status(`Image not loaded: ${e.message}`); }
    finally { if (url) URL.revokeObjectURL(url); endJob(); }
  };
  function maskBlob() {
    const output = document.createElement("canvas"); output.width = width; output.height = height;
    const outputCtx = output.getContext("2d"), data = outputCtx.createImageData(width, height);
    for (let i = 0; i < pixels; i++) {
      const j = i * 4, value = mask[i] ? 255 : 0;
      data.data[j] = data.data[j + 1] = data.data[j + 2] = value; data.data[j + 3] = 255;
    }
    outputCtx.putImageData(data, 0, 0);
    return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode selection mask.")), "image/png"));
  }
  $("#clipProcess").onclick = async () => {
    if (!file || !selected || stroke) return status("Select clothing pixels first.");
    const overfit = Number($("#clipOverfit").value), modtype = $("#clipModtype").value;
    if (!$("#clipOverfit").value.trim() || !Number.isInteger(overfit) || overfit < 0 || overfit > 20) return status("Overfit must be an integer from 0 to 20.");
    if (!["TOP", "BOTTOMS"].includes(modtype)) return status("Choose TOP or BOTTOMS.");
    if (!beginJob("Uploading image and selection...")) return;
    let jobId = null;
    try {
      const fd = new FormData(); fd.append("image", file, file.name);
      fd.append("mask", await maskBlob(), "selection.png");
      fd.append("modtype", modtype); fd.append("overfitPx", String(overfit));
      const queued = await requestJson(api("/api/costume"), { method: "POST", body: fd });
      if (typeof queued.jobId !== "string") throw new Error(queued.error || "Conversion did not return a job.");
      jobId = queued.jobId;
    } catch (e) { endJob(); return status(`Process failed: ${e.message}`); }
    endJob();
    const session = jobSession;
    let failures = 0;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (session !== jobSession) return;
      let job = null;
      try {
        job = await requestJson(api(`/api/costume/jobs/${encodeURIComponent(jobId)}`));
        failures = 0;
      } catch (e) {
        if (++failures > 10 || session !== jobSession) {
          if (session === jobSession) status(`Lost track of queued job: ${e.message}`);
          return;
        }
        continue;
      }
      if (session !== jobSession) return;
      if (job.status === "done") {
        const r = job.result || {};
        if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(r.id)) return status("Conversion finished with an invalid result.");
        resetJob();
        id = r.id; $("#swfId").textContent = id; syncDl(); $("#types").value = "image";
        const regions = Array.isArray(r.regions) ? r.regions.join(", ") : String(r.regions || "none reported");
        status(`SWF ready: ${(Number(r.bytes || 0) / 1024).toFixed(1)} KB. Regions: ${regions}. ${r.exportError ? "Asset export failed; download the SWF or retry Images export below." : "Edit the image cards below, then download current.swf."}`);
        renderExports(r, "image");
        refreshLoad();
        return;
      }
      if (job.status === "error") { refreshLoad(); return status(`Process failed: ${(job.error && job.error.message) || "unknown error"}`); }
      if (job.status === "queued") {
        const q = job.queue || {};
        status(`Queued — #${job.position || 1} in line (${q.pending || 0} waiting, ${q.completedLast5Min || 0} done in last 5 min). This continues in the background; starting another upload stops tracking it here.`);
      } else status("Compiling SWF on backend; please wait...");
    }
  };
  controls();
})();
