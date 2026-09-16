const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const express = require("express");
const { installCostume, prepareCostume } = require("../costume");

const ROOT = path.resolve(__dirname, "..");
const TEMP = process.platform === "win32"
  ? "C:\\Users\\throw\\AppData\\Local\\Temp\\opencode"
  : path.join(ROOT, "work");
const FFDEC = process.env.FFDEC_BIN || "C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe";
const PYTHON = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const execute = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const SWF = Buffer.from("FWS\x09fake compiled costume");

function option(args, name) {
  return args[args.indexOf(name) + 1];
}

async function fakePrepare(args) {
  const output = option(args, "--output");
  fs.mkdirSync(path.join(output, "images"));
  fs.writeFileSync(path.join(output, "images", "36.png"), PNG);
  return { regions: ["chestTop"] };
}

async function fakeFfdec(args) {
  if (args[0] === "-importImages") fs.writeFileSync(args[2], SWF);
  else if (args[0] === "-replace") fs.copyFileSync(args[1], args[2]);
  else if (args[0] === "-export") {
    fs.mkdirSync(path.join(args[2], "images"), { recursive: true });
    fs.writeFileSync(path.join(args[2], "images", "36.png"), PNG);
  } else throw new Error(`Unexpected FFDec command: ${args[0]}`);
  return { stdout: "", stderr: "" };
}

async function fixture(t, { prepare = fakePrepare, runFfdec = fakeFfdec, now } = {}) {
  assert.ok(fs.statSync(TEMP).isDirectory());
  const tempDir = fs.mkdtempSync(path.join(TEMP, "costume-test-"));
  const workDir = path.join(tempDir, "work");
  fs.mkdirSync(workDir);
  fs.mkdirSync(path.join(workDir, "_tmp"));
  let server;
  t.after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const app = express();
  const listen = app.listen;
  app.listen = () => {};
  const calls = [];
  const prepareCalls = [];
  const runner = async args => {
    calls.push(args);
    return runFfdec(args);
  };
  const prepared = async args => {
    prepareCalls.push(args);
    return prepare(args);
  };
  const serverPath = path.join(ROOT, "server.js");
  const nativeRequire = createRequire(serverPath);
  let installations = 0;
  vm.runInNewContext(fs.readFileSync(serverPath, "utf8"), {
    require(name) {
      if (name === "express") return Object.assign(() => app, express);
      if (name === "./costume") return {
        installCostume(target, dependencies) {
          installations++;
          installCostume(target, { ...dependencies, prepare: prepared, runFfdec: runner, ...(now ? { now } : {}) });
        },
      };
      if (name === "child_process") return {
        execFile(binary, args, options, callback) {
          runner(args).then(
            result => callback(null, result.stdout || "", result.stderr || ""),
            error => callback(error, error.stdout || "", error.stderr || "")
          );
        },
      };
      return nativeRequire(name);
    },
    __dirname: ROOT,
    process: { env: { ...process.env, WORK_DIR: workDir, FFDEC_BIN: FFDEC, PORT: "0" } },
    console,
    Buffer,
    setTimeout,
  }, { filename: serverPath });
  assert.equal(installations, 1);
  app.listen = listen;
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    tempDir,
    workDir,
    calls,
    prepareCalls,
    request: (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(180000) }),
  };
}

function form({ image = PNG, mask = PNG, modtype = "TOP", overfitPx = "4", extra = [] } = {}) {
  const body = new FormData();
  if (image !== null) body.append("image", new Blob([image], { type: "image/png" }), "source.png");
  if (mask !== null) body.append("mask", new Blob([mask], { type: "image/png" }), "selection.png");
  if (modtype !== null) body.append("modtype", modtype);
  if (overfitPx !== null) body.append("overfitPx", overfitPx);
  for (const [name, value] of extra) body.append(name, value);
  return body;
}

async function submit(h, body = form()) {
  const response = await h.request("/api/costume", { method: "POST", body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function waitFor(h, jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await h.request(`/api/costume/jobs/${jobId}`);
    assert.equal(response.status, 200, `job poll: ${response.status}`);
    const job = await response.json();
    if (job.status === "done" || job.status === "error") return job;
    assert.ok(["queued", "processing"].includes(job.status), JSON.stringify(job));
    assert.ok(Date.now() < deadline, "timed out waiting for job");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function submitAndWait(h, body = form()) {
  const enqueued = await submit(h, body);
  assert.equal(enqueued.status, 202, JSON.stringify(enqueued.body));
  assert.match(enqueued.body.jobId, /^[A-Za-z0-9_-]{4,64}$/);
  return waitFor(h, enqueued.body.jobId);
}

function assertClean(h, ids = []) {
  assert.deepEqual(fs.readdirSync(path.join(h.workDir, "_tmp")), []);
  assert.deepEqual(fs.readdirSync(h.workDir).sort(), ["_tmp", ...ids].sort());
  for (const id of ids) assert.equal(fs.existsSync(path.join(h.workDir, id, "images")), false);
}

async function assertCreated(h, result, regions = ["chestTop"]) {
  assert.equal(result.status, "done", JSON.stringify(result));
  const data = result.result;
  assert.match(data.id, /^[A-Za-z0-9_-]{4,64}$/);
  assert.deepEqual(data.regions, regions);
  assert.equal(data.types, "image");
  assert.equal(data.count, data.files.length);
  assert.ok(data.count > 0);
  assert.equal(data.exportError, undefined);
  const current = fs.readFileSync(path.join(h.workDir, data.id, "current.swf"));
  assert.ok(["FWS", "CWS", "ZWS"].includes(current.subarray(0, 3).toString()));
  assert.equal(data.bytes, current.length);
  assert.deepEqual(fs.readFileSync(path.join(h.workDir, data.id, "original.swf")), current);
  const download = await h.request(`/api/swf/${data.id}/download`);
  assert.equal(download.status, 200);
  assert.ok(download.headers.get("content-disposition").includes(`mod-${data.id}.swf`));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), current);
  for (const file of data.files) {
    assert.equal(typeof file.path, "string");
    assert.ok(!file.path.includes("\\"));
    assert.ok(Number.isInteger(file.bytes) && file.bytes > 0);
    const response = await h.request(`/api/swf/${data.id}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, file.bytes);
    assert.deepEqual(bytes, fs.readFileSync(path.join(h.workDir, data.id, "exports", file.path)));
  }
  return data;
}

test("frontend four-part upload creates a downloadable costume", async t => {
  const h = await fixture(t);
  const data = await assertCreated(h, await submitAndWait(h));
  assertClean(h, [data.id]);
});

test("three-part upload with default overfit succeeds", async t => {
  const h = await fixture(t);
  const body = form({ overfitPx: null });
  const data = await assertCreated(h, await submitAndWait(h, body));
  assert.equal(option(h.prepareCalls[0], "--overfit-px"), "4");
  assertClean(h, [data.id]);
});

test("missing fields, bad modtype, and invalid overfit never reach prepare", async t => {
  const h = await fixture(t);
  const cases = [
    ["empty multipart", () => new FormData()],
    ["missing image", () => form({ image: null, overfitPx: null })],
    ["missing mask", () => form({ mask: null, overfitPx: null })],
    ["missing modtype", () => form({ modtype: null, overfitPx: null })],
    ...["", "top", "BOTTOM", "OTHER"].map(modtype => [
      `modtype ${JSON.stringify(modtype)}`, () => form({ modtype, overfitPx: null }),
    ]),
    ...["", "-1", "21", "100", "1.5", "NaN", "Infinity", "1e1", "+1", " 4", "4 "].map(overfitPx => [
      `overfit ${JSON.stringify(overfitPx)}`, () => form({ overfitPx }),
    ]),
    ["JSON instead of multipart", () => JSON.stringify({ modtype: "TOP", overfitPx: 4 })],
  ];
  for (const [name, body] of cases) await t.test(name, async () => {
    const result = await submit(h, body());
    assert.equal(result.status, 400);
    assert.equal(typeof result.body.error, "string");
    assert.equal(h.prepareCalls.length, 0);
    assert.equal(h.calls.length, 0);
    assertClean(h);
  });
  const data = await assertCreated(h, await submitAndWait(h, form({ overfitPx: null })));
  assertClean(h, [data.id]);
});

test("multipart rejects files over 20 MB and surplus fields with cleanup", async t => {
  const h = await fixture(t);
  const cases = [
    ["oversized image", () => form({ image: Buffer.alloc(20 * 1024 * 1024 + 1), overfitPx: null }), 413],
    ["oversized mask", () => form({ mask: Buffer.alloc(20 * 1024 * 1024 + 1), overfitPx: null }), 413],
    ["extra text field", () => form({ extra: [["unexpected", "value"]] }), 400],
    ["extra file", () => form({ overfitPx: null, extra: [["unexpected", new Blob([PNG])]] }), 400],
    ["duplicate image", () => form({ overfitPx: null, extra: [["image", new Blob([PNG])]] }), 400],
    ["duplicate mask", () => form({ overfitPx: null, extra: [["mask", new Blob([PNG])]] }), 400],
    ["oversized text field", () => form({ modtype: "T".repeat(101), overfitPx: null }), 400],
    ["duplicate modtype", () => form({ overfitPx: null, extra: [["modtype", "BOTTOMS"]] }), 400],
  ];
  for (const [name, body, status] of cases) await t.test(name, async () => {
    const result = await submit(h, body());
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.match(result.body.error, /Upload one image/);
    assert.equal(h.prepareCalls.length, 0);
    assert.equal(h.calls.length, 0);
    assertClean(h);
  });
  const data = await assertCreated(h, await submitAndWait(h, form({ overfitPx: null })));
  assertClean(h, [data.id]);
});

test("fake prepare errors remove partial work and release busy", async t => {
  for (const validation of [true, false]) await t.test(validation ? "validation 422" : "runtime 500", async t => {
    let fail = true;
    const h = await fixture(t, {
      async prepare(args) {
        const result = await fakePrepare(args);
        if (fail) throw Object.assign(new Error("private prepare failure"), { validation, detail: "private detail" });
        return result;
      },
    });
    const failed = await submitAndWait(h, form({ overfitPx: null }));
    assert.equal(failed.status, "error");
    assert.equal(failed.error.code, validation ? 422 : 500);
    assert.doesNotMatch(failed.error.message, /private/);
    assert.equal(h.prepareCalls.length, 1);
    assert.equal(h.calls.length, 0);
    assertClean(h);
    fail = false;
    const data = await assertCreated(h, await submitAndWait(h, form({ overfitPx: null })));
    assertClean(h, [data.id]);
  });
});

test("FFDec import failures and invalid output remove all partial work", async t => {
  for (const failure of ["reject", "missing", "invalid", "short"]) await t.test(failure, async t => {
    let fail = true;
    const h = await fixture(t, {
      async runFfdec(args) {
        if (fail && args[0] === "-importImages") {
          if (failure === "reject") {
            fs.writeFileSync(args[2], SWF);
            throw new Error("private ffdec failure");
          }
          if (failure !== "missing") fs.writeFileSync(args[2], failure === "short" ? "FW" : "not a SWF");
          return { stdout: "", stderr: "" };
        }
        return fakeFfdec(args);
      },
    });
    const failed = await submitAndWait(h, form({ overfitPx: null }));
    assert.equal(failed.status, "error");
    assert.equal(failed.error.code, 500);
    assert.doesNotMatch(failed.error.message, /private/);
    assert.equal(h.calls.length, 1);
    assertClean(h);
    fail = false;
    const data = await assertCreated(h, await submitAndWait(h, form({ overfitPx: null })));
    assertClean(h, [data.id]);
  });
});

test("export failure preserves downloadable original/current and allows retry", async t => {
  let fail = true;
  const h = await fixture(t, {
    async runFfdec(args) {
      if (fail && args[0] === "-export") throw new Error("private export failure");
      return fakeFfdec(args);
    },
  });
  const result = await submitAndWait(h, form({ overfitPx: null }));
  assert.equal(result.status, "done");
  const data = result.result;
  assert.equal(data.types, "image");
  assert.deepEqual(data.regions, ["chestTop"]);
  assert.equal(data.count, 0);
  assert.deepEqual(data.files, []);
  assert.match(data.exportError, /Use Export to retry/);
  assert.equal(data.bytes, SWF.length);
  assert.deepEqual(fs.readFileSync(path.join(h.workDir, data.id, "original.swf")), SWF);
  const download = await h.request(`/api/swf/${data.id}/download`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), SWF);
  assertClean(h, [data.id]);
  fail = false;
  const response = await h.request(`/api/swf/${data.id}/export`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ types: "image" }),
  });
  assert.equal(response.status, 200);
  const exported = await response.json();
  assert.equal(exported.count, 1);
  assert.deepEqual(exported.files, [{ path: "images/36.png", bytes: PNG.length }]);
  const next = await assertCreated(h, await submitAndWait(h, form({ overfitPx: null })));
  assert.notEqual(next.id, data.id);
  assertClean(h, [data.id, next.id]);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("concurrent uploads queue with positions and run FIFO", { timeout: 30000 }, async t => {
  const entered = deferred();
  const release = deferred();
  let blocked = true;
  const h = await fixture(t, {
    async prepare(args) {
      if (blocked) {
        entered.resolve();
        await release.promise;
        blocked = false;
      }
      return fakePrepare(args);
    },
  });
  const first = await submit(h, form({ overfitPx: null }));
  assert.equal(first.status, 202);
  assert.match(first.body.jobId, /^[A-Za-z0-9_-]{4,64}$/);
  await entered.promise;
  const second = await submit(h, form({ overfitPx: null }));
  assert.equal(second.status, 202);
  const waiting = await h.request(`/api/costume/jobs/${second.body.jobId}`).then(r => r.json());
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.position, 2);
  assert.equal(waiting.queue.pending, 1);
  assert.equal(waiting.queue.active, 1);
  const stats = await h.request("/api/costume/queue").then(r => r.json());
  assert.equal(stats.pending, 1);
  assert.equal(stats.active, 1);
  release.resolve();
  const doneA = await waitFor(h, first.body.jobId);
  const doneB = await waitFor(h, second.body.jobId);
  assert.equal(doneA.status, "done");
  assert.equal(doneB.status, "done");
  assert.ok(doneA.finishedAt <= doneB.startedAt);
  const after = await h.request("/api/costume/queue").then(r => r.json());
  assert.equal(after.pending, 0);
  assert.equal(after.active, 0);
  assert.ok(after.completedLast5Min >= 2);
  assertClean(h, [doneA.result.id, doneB.result.id]);
});

test("unknown and malformed job ids", async t => {
  const h = await fixture(t);
  const bad = await h.request("/api/costume/jobs/!!!");
  assert.equal(bad.status, 400);
  const missing = await h.request(`/api/costume/jobs/${"0".repeat(36)}`);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /24 hours/);
  assertClean(h);
});

test("terminal jobs expire after 24 hours", async t => {
  let clock = 1_000_000;
  const h = await fixture(t, { now: () => clock });
  const done = await submitAndWait(h, form({ overfitPx: null }));
  assert.equal(done.status, "done");
  clock += 25 * 60 * 60 * 1000;
  const stats = await h.request("/api/costume/queue").then(r => r.json());
  assert.equal(stats.retained24h, 0);
  const gone = await h.request(`/api/costume/jobs/${done.jobId}`);
  assert.equal(gone.status, 404);
  assertClean(h, [done.result.id]);
});
async function python(code, args = []) {
  return execute(PYTHON, ["-B", "-c", code, ...args], {
    timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
}

async function inspectImages(directory) {
  const result = await python([
    "import hashlib, json, sys",
    "from pathlib import Path",
    "from PIL import Image",
    "result = {}",
    "for filename in Path(sys.argv[1]).rglob('*.png'):",
    "    with Image.open(filename) as image:",
    "        image.load()",
    "        rgba = image.convert('RGBA')",
    "        result[filename.stem] = {'size': list(image.size), 'hash': hashlib.sha256(rgba.tobytes()).hexdigest(), 'visible': rgba.getchannel('A').getbbox() is not None}",
    "print(json.dumps(result))",
  ].join("\n"), [directory]);
  return JSON.parse(result.stdout);
}

test("real prepareCostume and FFDec TOP/BOTTOMS export, replacement, and download", { timeout: 600000 }, async t => {
  if (!fs.existsSync(FFDEC)) return t.skip(`FFDec unavailable: ${FFDEC}`);
  try {
    await python("from PIL import Image; print(Image.__version__)");
  } catch (error) {
    return t.skip(`Python/Pillow unavailable: ${error.message}`);
  }
  const realFfdec = args => execute(FFDEC, args, {
    timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    shell: FFDEC.toLowerCase().endsWith(".bat"),
  });
  for (const modtype of ["TOP", "BOTTOMS"]) await t.test(modtype, async t => {
    let expected;
    let prepared;
    const h = await fixture(t, {
      async prepare(args) {
        prepared = await prepareCostume(args);
        const images = path.join(option(args, "--output"), "images");
        expected = await inspectImages(images);
        fs.cpSync(images, path.join(h.tempDir, "prepared"), { recursive: true });
        return prepared;
      },
      runFfdec: realFfdec,
    });
    const fixtures = path.join(h.tempDir, "fixtures");
    fs.mkdirSync(fixtures);
    const target = modtype === "TOP" ? "36" : "20";
    const region = modtype === "TOP" ? "chestTop" : "rightCalf";
    await python([
      "import sys",
      "from pathlib import Path",
      "from PIL import Image",
      "root = Path(sys.argv[1])",
      "top = sys.argv[2] == 'TOP'",
      "Image.new('RGBA', (1024, 1280), (200, 100, 50, 255)).save(root / 'source.png')",
      "mask = Image.new('RGB', (1024, 1280))",
      "mask.paste((255, 0, 0) if top else (255, 0, 128), (363, 475, 783, 934) if top else (39, 1135, 815, 1280))",
      "mask.save(root / 'mask.png')",
      "Image.new('RGBA', (274, 561) if top else (776, 147), (12, 220, 90, 255)).save(root / 'replacement.png')",
    ].join("\n"), [fixtures, modtype]);
    const result = await submitAndWait(h, form({
      image: fs.readFileSync(path.join(fixtures, "source.png")),
      mask: fs.readFileSync(path.join(fixtures, "mask.png")),
      modtype, overfitPx: null,
    }));
    const data = await assertCreated(h, result, [region]);
    assert.deepEqual(prepared.regions, [region]);
    assert.equal(option(h.prepareCalls[0], "--modtype"), modtype);
    assert.equal(option(h.prepareCalls[0], "--overfit-px"), "4");
    assert.equal(path.basename(h.calls[0][1]), modtype === "TOP" ? "top_static.swf" : "bot_static.swf");
    const exportedDir = path.join(h.workDir, data.id, "exports");
    const actual = await inspectImages(exportedDir);
    const sizes = modtype === "TOP"
      ? { 27: [127, 430], 30: [182, 230], 33: [168, 244], 36: [274, 561], 39: [168, 244], 42: [439, 467], 45: [127, 430] }
      : { 5: [200, 162], 8: [779, 146], 11: [583, 487], 14: [267, 311], 17: [583, 498], 20: [776, 147], 23: [278, 224] };
    assert.equal(Object.keys(expected).length, 7);
    for (const [id, size] of Object.entries(sizes)) {
      assert.deepEqual(expected[id].size, size);
      assert.deepEqual(actual[id].size, expected[id].size);
      assert.equal(actual[id].visible, expected[id].visible);
    }
    await python([
      "import sys",
      "from pathlib import Path",
      "from PIL import Image, ImageChops",
      "expected, actual = map(Path, sys.argv[1:])",
      "for filename in expected.glob('*.png'):",
      "    matches = list(actual.rglob(filename.name))",
      "    assert len(matches) == 1, filename.name",
      "    with Image.open(filename) as a, Image.open(matches[0]) as b:",
      "        a, b = a.convert('RGBA'), b.convert('RGBA')",
      "        assert ImageChops.difference(a.getchannel('A'), b.getchannel('A')).getbbox() is None, filename.name + ': alpha changed'",
      "        for background in [(0, 0, 0, 255), (255, 255, 255, 255)]:",
      "            left = Image.alpha_composite(Image.new('RGBA', a.size, background), a).convert('RGB')",
      "            right = Image.alpha_composite(Image.new('RGBA', b.size, background), b).convert('RGB')",
          "            error = max(high for low, high in ImageChops.difference(left, right).getextrema())",
          "            assert error <= 8, f'{filename.name}: composited error {error}'",
    ].join("\n"), [path.join(h.tempDir, "prepared"), exportedDir]);
    assert.ok(actual[target].visible);
    assertClean(h, [data.id]);
    const original = fs.readFileSync(path.join(h.workDir, data.id, "original.swf"));
    const replacement = new FormData();
    replacement.append("file", new Blob([fs.readFileSync(path.join(fixtures, "replacement.png"))], { type: "image/png" }), "replacement.png");
    replacement.append("target", target);
    const replaced = await h.request(`/api/swf/${data.id}/replace`, { method: "POST", body: replacement });
    const replacementResult = await replaced.json();
    assert.equal(replaced.status, 200, JSON.stringify(replacementResult));
    assert.equal(replacementResult.ok, true);
    const current = fs.readFileSync(path.join(h.workDir, data.id, "current.swf"));
    assert.notDeepEqual(current, original);
    assert.equal(replacementResult.bytes, current.length);
    assert.deepEqual(fs.readFileSync(path.join(h.workDir, data.id, "original.swf")), original);
    assert.equal(fs.existsSync(path.join(h.workDir, data.id, "current.next.swf")), false);
    const download = await h.request(`/api/swf/${data.id}/download`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), current);
    const response = await h.request(`/api/swf/${data.id}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ types: "image" }),
    });
    assert.equal(response.status, 200, await response.text());
    const after = await inspectImages(exportedDir);
    const reference = await inspectImages(fixtures);
    assert.deepEqual(after[target], reference.replacement);
    for (const id of Object.keys(sizes)) {
      if (id !== target) assert.deepEqual(after[id], actual[id], `unmodified bitmap ${id}`);
    }
    assertClean(h, [data.id]);
  });
});

test("preview-hidden blanks assets in a temp copy without touching current.swf", async t => {
  const h = await fixture(t);
  const upload = new FormData();
  upload.append("swf", new Blob([Buffer.from("FWSfake")]), "mod.swf");
  const up = await h.request("/api/swf", { method: "POST", body: upload });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  for (const [payload, status] of [
    [JSON.stringify({ blanks: [] }), 400],
    [JSON.stringify({ blanks: "4" }), 400],
    [JSON.stringify({ blanks: ["abc"] }), 400],
    [JSON.stringify({ blanks: Array.from({ length: 21 }, (_, i) => String(i + 1)) }), 400],
    [JSON.stringify({}), 400],
  ]) await t.test(`rejects with ${status}`, async () => {
    const response = await h.request(`/api/swf/${id}/preview-hidden`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
    });
    assert.equal(response.status, status);
  });
  const missing = await h.request(`/api/swf/${"0".repeat(36)}/preview-hidden`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blanks: ["4"] }),
  });
  assert.equal(missing.status, 404);
  const ok = await h.request(`/api/swf/${id}/preview-hidden`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blanks: ["4"] }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), Buffer.from("FWSfake"));
  assert.equal(h.calls[0][0], "-replace");
  assert.equal(h.calls[0][1], path.join(h.workDir, id, "current.swf"));
  assert.equal(h.calls[0][3], "4");
  assert.deepEqual(fs.readFileSync(path.join(h.workDir, id, "current.swf")), Buffer.from("FWSfake"));
  for (let attempt = 0; attempt < 50; attempt++) {
    if (fs.readdirSync(path.join(h.workDir, "_tmp")).length === 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assertClean(h, [id]);
});
