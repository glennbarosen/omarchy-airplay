const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadQmlJs, repoRoot } = require("./helpers/load.js");

const Model = loadQmlJs("airplay/Model.js");

function qmlBlocks(source, component) {
  const blocks = [];
  const matcher = new RegExp(`\\b${component}\\s*\\{`, "g");
  let match;

  while ((match = matcher.exec(source)) !== null) {
    const start = match.index;
    let depth = 0;
    let quote = "";
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let index = source.indexOf("{", start); index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote !== "") {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }
      if (char === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      blocks.push(source.slice(start, index + 1));
      matcher.lastIndex = index + 1;
      break;
    }
  }

  return blocks;
}

test("receiver text is neutralized before entering shell-owned text surfaces", () => {
  assert.equal(
    Model.safeShellText('<img src="https://attacker.invalid/ping">TV<b>room</b>'),
    'img src="https://attacker.invalid/ping"TVbroom/b'
  );
  assert.equal(Model.safeShellText("회의실 TV"), "회의실 TV");
});

test("unknown receiver credential kinds never open an interactive prompt", () => {
  const row = Model.rowFor(
    "Hostile TV",
    "AppleTV14,1",
    "192.0.2.10",
    7000,
    { state: "pin_required", credential_kind: "future-kind" },
    "device-id"
  );
  assert.equal(row.credentialKind, "");
  assert.equal(row.needsCredential, false);
});

test("every plugin-owned Text renders plain text", () => {
  for (const relativePath of ["Panel.qml", "airplay/Section.qml"]) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    const blocks = qmlBlocks(source, "Text");
    assert.ok(blocks.length > 0, `${relativePath} must contain owned Text elements`);
    for (const block of blocks) {
      assert.match(
        block,
        /\btextFormat\s*:\s*Text\.PlainText\b/,
        `${relativePath} has an AutoText-capable Text block:\n${block}`
      );
    }
  }
});

test("receiver names are sanitized before shell-owned labels and tooltips", () => {
  const panel = fs.readFileSync(path.join(repoRoot, "Panel.qml"), "utf8");
  const section = fs.readFileSync(path.join(repoRoot, "airplay/Section.qml"), "utf8");
  const surfaces = [
    ...qmlBlocks(panel, "BarIconButton"),
    ...qmlBlocks(panel, "PanelHero"),
    ...qmlBlocks(section, "PanelToolTip"),
    ...qmlBlocks(section, "Button"),
    ...qmlBlocks(section, "PanelActionButton"),
  ];
  const receiverControlled = surfaces.filter(
    (block) => block.includes("heroText") || block.includes("row.name")
  );

  assert.ok(receiverControlled.length >= 4, "expected every known receiver-controlled shell surface");
  for (const block of receiverControlled) {
    assert.match(
      block,
      /Airplay\.safeShellText\s*\(/,
      `receiver-controlled text reached a shell component unsanitized:\n${block}`
    );
  }
});
