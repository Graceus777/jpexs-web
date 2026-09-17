const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} body ends`);
  return source.slice(start, end + 3);
}

const context = {};
vm.createContext(context);
vm.runInContext("const IMG = /\\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i, AUD = /\\.(mp3|wav|flv)$/i, AS = /\\.as$/i;", context);
vm.runInContext("function kindOf(path) { if (IMG.test(path)) return \"img\"; if (AUD.test(path)) return \"snd\"; if (AS.test(path)) return \"as\"; return \"other\"; }", context);
vm.runInContext(extract(html, "parseTarget"), context);
vm.runInContext(extract(html, "isEditableTarget"), context);
vm.runInContext(extract(html, "isRemovableTarget"), context);
vm.runInContext(extract(html, "hideKeyFor"), context);
vm.runInContext(extract(html, "splitHidden"), context);
const { parseTarget, isEditableTarget, isRemovableTarget, hideKeyFor, splitHidden, kindOf } = context;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function card(rel) {
  const { target, kind } = parseTarget(rel);
  return {
    target,
    kind,
    editable: isEditableTarget(rel, target, kind, kindOf(rel)),
    removable: isRemovableTarget(rel, target, kind),
  };
}

test("sprite frames resolve to the sprite, never swappable", () => {
  assert.deepEqual(plain(parseTarget("DefineSprite_4_SplashScreen/1.png")), { target: "4", kind: "sprite" });
  assert.deepEqual(plain(parseTarget("DefineSprite_29/1.png")), { target: "29", kind: "sprite" });
  assert.deepEqual(plain(parseTarget("DefineSprite_3/1.png")), { target: "3", kind: "sprite" });
  for (const rel of ["DefineSprite_4_SplashScreen/1.png", "DefineSprite_29/1.png"]) {
    assert.equal(card(rel).editable, false, rel);
  }
});

test("flat bitmap exports stay editable, shape SVGs do not", () => {
  assert.deepEqual(plain(parseTarget("36.png")), { target: "36", kind: "id" });
  assert.equal(card("36.png").editable, true);
  assert.equal(card("5.png").editable, true);
  assert.equal(card("12.mp3").editable, true);
  assert.equal(card("1.svg").editable, false);
  assert.deepEqual(plain(parseTarget("scripts/com/foo/Bar.as")), { target: "com.foo.Bar", kind: "script" });
  assert.equal(card("scripts/com/foo/Bar.as").editable, true);
});

test("sprite frames are removable (splash screens included), images are not", () => {
  for (const rel of ["DefineSprite_4_SplashScreen/1.png", "DefineSprite_29/1.png", "DefineSprite_3/1.png"]) {
    const c = card(rel);
    assert.equal(c.removable, true, rel);
    assert.equal(c.editable, false, rel);
  }
  assert.equal(card("36.png").removable, false);
  assert.equal(card("12.mp3").removable, false);
  assert.equal(card("scripts/com/foo/Bar.as").removable, false);
});

test("sprite hides use prefixed keys and split into blanks/remove", () => {
  assert.equal(hideKeyFor("4", "sprite"), "sprite:4");
  assert.equal(hideKeyFor("11", "id"), "11");
  assert.deepEqual(plain(splitHidden(["11", "sprite:4"])), { blanks: ["11"], remove: ["4"] });
  assert.deepEqual(plain(splitHidden(["sprite:4", "sprite:3"])), { blanks: [], remove: ["4", "3"] });
  assert.deepEqual(plain(splitHidden([])), { blanks: [], remove: [] });
});
