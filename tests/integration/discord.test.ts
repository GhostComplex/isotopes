#!/usr/bin/env npx tsx
/**
 * Integration test for Isotopes Discord bot
 *
 * Prerequisites:
 * 1. Set environment variables:
 *    - DISCORD_TOKEN: Bot token
 *    - DISCORD_TEST_CHANNEL: Channel ID to test in
 *    - ANTHROPIC_API_KEY or OPENAI_API_KEY: LLM provider
 *
 * 2. Bot must be in the test channel with permissions:
 *    - Read Messages
 *    - Send Messages
 *    - Read Message History
 *
 * Usage:
 *   npx tsx tests/integration/discord.test.ts
 *
 * What it tests:
 * 1. Discord login
 * 2. Send test message to channel
 * 3. Verify bot receives and processes message
 * 4. Verify bot sends response
 */

import { Client, GatewayIntentBits, TextChannel, Events } from "discord.js";
import {
  PiMonoCore,
  DefaultAgentManager,
  DefaultSessionStore,
  DiscordTransport,
} from "../../src/index.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TEST_CHANNEL_ID = process.env.DISCORD_TEST_CHANNEL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function checkEnv() {
  const missing: string[] = [];
  if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  if (!TEST_CHANNEL_ID) missing.push("DISCORD_TEST_CHANNEL");
  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
    missing.push("ANTHROPIC_API_KEY or OPENAI_API_KEY");
  }

  if (missing.length > 0) {
    console.error("❌ Missing environment variables:");
    missing.forEach((v) => console.error(`   - ${v}`));
    console.error("\nSet them and retry.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function runTest() {
  checkEnv();
  log("🚀 Starting integration test...");

  // Create temp workspace
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isotopes-test-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "SOUL.md"),
    "You are a test bot. Reply with 'PONG' to any message containing 'PING'.",
  );

  log(`📁 Created temp workspace: ${tempDir}`);

  // Initialize components
  const core = new PiMonoCore();
  const agentManager = new DefaultAgentManager(core);
  const sessionStore = new DefaultSessionStore({ dataDir: path.join(tempDir, "sessions") });

  // Create test agent
  await agentManager.create({
    id: "test-agent",
    name: "Test Agent",
    systemPrompt: "You are a test bot. If user says PING, reply PONG. Be very brief.",
    workspacePath,
    provider: ANTHROPIC_API_KEY
      ? { type: "anthropic", apiKey: ANTHROPIC_API_KEY, model: "claude-sonnet-4-20250514" }
      : { type: "openai", apiKey: OPENAI_API_KEY!, model: "gpt-4o-mini" },
  });

  log("✅ Created test agent");

  // Start Discord transport
  const transport = new DiscordTransport({
    token: DISCORD_TOKEN!,
    agentManager,
    sessionStore,
    defaultAgentId: "test-agent",
    channelAllowlist: [TEST_CHANNEL_ID!],
  });

  await transport.start();
  log("✅ Discord transport started");

  // Wait for ready
  await sleep(2000);

  // Create a separate client to send test messages
  const testClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let testPassed = false;
  const testMessage = `PING ${Date.now()}`;

  // Listen for bot's response
  testClient.on(Events.MessageCreate, (msg) => {
    if (msg.channelId === TEST_CHANNEL_ID && msg.author.bot) {
      log(`📨 Bot replied: ${msg.content.substring(0, 100)}`);
      if (msg.content.toUpperCase().includes("PONG")) {
        testPassed = true;
        log("✅ Test PASSED: Bot responded with PONG");
      }
    }
  });

  await testClient.login(DISCORD_TOKEN);
  log("✅ Test client logged in");

  // Send test message
  const channel = (await testClient.channels.fetch(TEST_CHANNEL_ID!)) as TextChannel;
  if (!channel) {
    throw new Error(`Channel ${TEST_CHANNEL_ID} not found`);
  }

  // Get bot user ID for mention
  const botUser = transport["client"].user;
  if (!botUser) {
    throw new Error("Bot user not available");
  }

  log(`📤 Sending test message: @${botUser.username} ${testMessage}`);
  await channel.send(`<@${botUser.id}> ${testMessage}`);

  // Wait for response (max 30 seconds)
  log("⏳ Waiting for response (max 30s)...");
  const startTime = Date.now();
  while (!testPassed && Date.now() - startTime < 30000) {
    await sleep(500);
  }

  // Cleanup
  log("🧹 Cleaning up...");
  await transport.stop();
  testClient.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });

  if (testPassed) {
    log("🎉 Integration test PASSED!");
    process.exit(0);
  } else {
    log("❌ Integration test FAILED: No PONG response received");
    process.exit(1);
  }
}

runTest().catch((error) => {
  console.error("❌ Test failed with error:", error);
  process.exit(1);
});
