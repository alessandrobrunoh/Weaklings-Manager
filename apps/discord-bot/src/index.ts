import { Client, GatewayIntentBits, Events } from "discord.js";
import { config } from "./config.js";
import { ApiClient } from "./api/client.js";
import { commands } from "./commands/index.js";
import { handleButton } from "./handlers/button.js";
import { handleSelectMenu } from "./handlers/select.js";
import { Poller } from "./services/poller.js";
import { initSettingsService } from "./services/settings.js";
import { registerCommands } from "./services/registry.js";
import { createResponseEmbed } from "./embeds/theme.js";

const THREAD_AUTOCREATE_BUILD_MARKER = "event-thread-signup-message-2026-08-16";

/**
 * Albion Guild Manager — Discord Bot
 *
 * Entry point. Boots the discord.js client, registers slash commands,
 * wires up interaction handlers, and starts the polling service.
 */
async function main(): Promise<void> {
  console.log("🤖 Albion Guild Manager Bot starting…");
  console.log(`[Bot] Build marker: ${THREAD_AUTOCREATE_BUILD_MARKER}`);

  // Create the API client (shared across all handlers)
  const api = new ApiClient(config.BACKEND_URL, config.BOT_API_SECRET);
  // Channel/role IDs now live in the backend's admin Settings instead of this
  // process's own env vars — see services/settings.ts.
  const settings = initSettingsService(api);

  // Register slash commands with Discord (guild-scoped = instant refresh)
  await registerCommands();

  // Create the Discord client
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // ── Interaction handler ──────────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) {
        console.warn(`[Bot] Unknown command: ${interaction.commandName}`);
        const warnEmbed = createResponseEmbed(
          "warning",
          "Unknown Command",
          "Command not recognized by bot system.",
          "COMMAND ERROR",
        );
        await interaction.reply({ embeds: [warnEmbed], flags: ["Ephemeral"] });
        return;
      }

      try {
        await command.execute(interaction, api);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred.";
        console.error(`[Bot] Error in /${interaction.commandName}:`, err);

        const errEmbed = createResponseEmbed(
          "error",
          "Command Error",
          message,
          "COMMAND FAILED",
        );
        const reply = { embeds: [errEmbed], flags: ["Ephemeral"] as any };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
        }
      }
      return;
    }

    // Button interactions
    if (interaction.isButton()) {
      await handleButton(interaction, api);
      return;
    }

    // Select menu interactions
    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction, api);
      return;
    }
  });

  // ── Ready handler ────────────────────────────────────────────────────────
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`✅ Logged in as ${readyClient.user.tag}`);

    // Start the polling service after the client is ready
    const poller = new Poller(readyClient, api, settings, config.POLL_INTERVAL_MS);
    poller.start();

    // Graceful shutdown
    const shutdown = (): void => {
      console.log("[Bot] Shutting down…");
      poller.stop();
      readyClient.destroy();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  // ── Login ────────────────────────────────────────────────────────────────
  await loginWithBackoff(client, config.DISCORD_BOT_TOKEN);
}

/**
 * Logs in with retry + backoff instead of letting a failed login crash the
 * process.
 *
 * Discord enforces a daily budget on gateway session starts. A container that
 * `process.exit(1)`s on every failed login gets restarted instantly by
 * Docker's `restart: unless-stopped`, which burns through that budget in a
 * tight loop and locks the bot out for the rest of the day. This retries
 * in-process instead, honoring the "resets at <timestamp>" hint Discord
 * includes in that specific error when present, and falling back to capped
 * exponential backoff otherwise.
 */
async function loginWithBackoff(client: Client, token: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await client.login(token);
      return;
    } catch (err) {
      attempt++;
      const message = err instanceof Error ? err.message : String(err);
      const waitMs =
        resolveResetDelayMs(message) ?? Math.min(30_000 * attempt, 5 * 60_000);
      console.error(`[Bot] Login attempt ${attempt} failed: ${message}`);
      console.error(`[Bot] Retrying in ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
    }
  }
}

/** Parses discord.js's "…resets at 2026-08-12T19:39:07.744Z" hint, if present. */
function resolveResetDelayMs(message: string): number | null {
  const match = message.match(/resets at ([^\s]+)/i);
  if (!match) return null;
  const resetAt = new Date(match[1]).getTime();
  if (Number.isNaN(resetAt)) return null;
  const delta = resetAt - Date.now() + 5_000; // small buffer past the reset
  return Math.max(5_000, delta);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
