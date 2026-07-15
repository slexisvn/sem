const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const source = path.join(repoRoot, "dist", "index.js");
const targetDir = path.join(extensionRoot, "out", "sem");

if (!fs.existsSync(source)) {
  throw new Error("Missing dist/index.js. Run npm --prefix .. run build first.");
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, path.join(targetDir, "index.js"));
fs.writeFileSync(path.join(targetDir, "package.json"), '{\n  "type": "module"\n}\n');
