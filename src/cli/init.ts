import fs from "node:fs/promises";
import { getConfigPath, getIsotopesHome } from "../paths.js";

export async function handleInitCommand(force: boolean): Promise<void> {
  const home = getIsotopesHome();
  const configPath = getConfigPath();
  await fs.mkdir(home, { recursive: true });

  const exists = await fs.stat(configPath).then(() => true).catch(() => false);
  if (exists && !force) {
    console.error(`Config already exists: ${configPath}`);
    console.error(`Re-run with --force to overwrite.`);
    process.exit(1);
  }

  const { runInitWizard } = await import("../init/wizard.js");
  const { toYaml } = await import("../init/to-yaml.js");
  const answers = await runInitWizard();
  const yaml = toYaml(answers);

  await fs.writeFile(configPath, yaml, "utf-8");
  console.log(`Wrote config to ${configPath}`);
  console.log(``);
  console.log(`Next:`);
  console.log(`  • isotopes        # run in foreground`);
  console.log(`  • isotopes tui    # interactive TUI`);
}
