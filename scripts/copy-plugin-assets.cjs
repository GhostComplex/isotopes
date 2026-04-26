// scripts/copy-plugin-assets.js — Copy non-TS assets to dist/
// Cross-platform (no shell-specific commands)

const fs = require("fs");
const path = require("path");

// --- Plugin manifests ---
const pluginsDir = path.join(__dirname, "..", "src", "plugins");

for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = path.join(pluginsDir, entry.name, "isotopes.plugin.json");
  if (!fs.existsSync(manifest)) continue;

  const destDir = path.join(__dirname, "..", "dist", "plugins", entry.name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(manifest, path.join(destDir, "isotopes.plugin.json"));
}

// --- Workspace template files ---
const templateSrc = path.join(__dirname, "..", "src", "workspace", "template-files");
const templateDest = path.join(__dirname, "..", "dist", "workspace", "template-files");

if (fs.existsSync(templateSrc)) {
  fs.mkdirSync(templateDest, { recursive: true });
  for (const file of fs.readdirSync(templateSrc)) {
    fs.copyFileSync(path.join(templateSrc, file), path.join(templateDest, file));
  }
}
