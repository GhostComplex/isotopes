// src/core/claude-settings-init.ts — Side-effect entry that runs the loader at import time
// Imported for its side effect from cli.ts before any other module reads process.env.
import { loadClaudeSettingsEnv } from "./claude-settings.js";

loadClaudeSettingsEnv();
