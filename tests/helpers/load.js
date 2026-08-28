// Loads a QML JavaScript resource (airplay/*.js) into a bare V8 context so
// Node can test it directly. These files are imported by QML as
// `import "Protocol.js" as Proto`, so they must not use CommonJS or ESM
// syntax — top-level function declarations are the whole interface. Running
// them in a vm context turns those declarations into context properties,
// which is exactly what QML does with them too.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..");

// Objects built inside a vm context carry that context's Object.prototype, so
// node:assert's deepEqual would reject them purely on realm identity. Reviving
// returned values through this realm's JSON keeps the assertions about the
// values under test rather than about which realm produced them.
function sameRealm(value) {
  if (value === undefined || typeof value === "function") return value;
  return JSON.parse(JSON.stringify(value));
}

function loadQmlJs(relativePath) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const context = vm.createContext(Object.create(null));
  vm.runInContext(source, context, { filename: relativePath });

  // Wrap every exported function so its return value lands in this realm.
  const wrapped = {};
  for (const key of Object.getOwnPropertyNames(context)) {
    const member = context[key];
    if (typeof member === "function") {
      wrapped[key] = (...args) => sameRealm(member(...args));
    } else {
      wrapped[key] = sameRealm(member);
    }
  }
  // Mutating helpers need the real object identity, not a JSON revival.
  wrapped.raw = context;
  return wrapped;
}

module.exports = { loadQmlJs, repoRoot, sameRealm };
