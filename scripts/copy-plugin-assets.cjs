// scripts/copy-plugin-assets.js — Copy plugin manifest files to dist/
// Cross-platform (no shell-specific commands)

const fs = require("fs");
const path = require("path");

const pluginsDir = path.join(__dirname, "..", "src", "plugins");

for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = path.join(pluginsDir, entry.name, "isotopes.plugin.json");
  if (!fs.existsSync(manifest)) continue;

  const destDir = path.join(__dirname, "..", "dist", "plugins", entry.name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(manifest, path.join(destDir, "isotopes.plugin.json"));
}
