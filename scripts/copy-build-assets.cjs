// scripts/copy-build-assets.cjs — Copy non-TS assets to dist/
// Cross-platform (no shell-specific commands)

const fs = require("fs");
const path = require("path");

// Workspace template files (read at runtime by agents/workspace/templates.ts)
const templateSrc = path.join(__dirname, "..", "src", "agent", "workspace", "template-files");
const templateDest = path.join(__dirname, "..", "dist", "agent", "workspace", "template-files");

if (fs.existsSync(templateSrc)) {
  fs.mkdirSync(templateDest, { recursive: true });
  for (const file of fs.readdirSync(templateSrc)) {
    fs.copyFileSync(path.join(templateSrc, file), path.join(templateDest, file));
  }
}
