# Integration Tests

These tests require real credentials and network access. They are **not** run in CI.

## Prerequisites

1. **Discord Bot** — Create at https://discord.com/developers/applications
   - Enable "Message Content Intent" in Bot settings
   - Add to a test server with permissions: Read Messages, Send Messages, Read Message History

2. **LLM API Key** — Anthropic or OpenAI

3. **Test Channel** — A Discord channel for testing

## Environment Variables

```bash
export DISCORD_TOKEN="your-bot-token"
export DISCORD_TEST_CHANNEL="channel-id"
export ANTHROPIC_API_KEY="sk-ant-..."  # or OPENAI_API_KEY
```

## Running Tests

```bash
# Run Discord integration test
npx tsx tests/integration/discord.test.ts
```

## What It Tests

### discord.test.ts

1. ✅ Discord login
2. ✅ Create agent with workspace
3. ✅ Start Discord transport
4. ✅ Send @mention message to channel
5. ✅ Bot processes message → calls LLM
6. ✅ Bot sends response
7. ✅ Verify response content

## Test Isolation

- Each test run creates a temporary workspace
- Cleanup happens automatically after test
- Uses unique message IDs to avoid conflicts

## Troubleshooting

**Bot doesn't respond:**
- Check bot is in the channel
- Check Message Content Intent is enabled
- Check channelAllowlist includes test channel

**API errors:**
- Verify API key is valid
- Check rate limits

**Timeout:**
- LLM response may be slow — test waits up to 30s
