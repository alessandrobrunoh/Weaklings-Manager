import { Client, GatewayIntentBits, Events } from "discord.js";
import { config } from "./config.js";
import { ApiClient } from "./api/client.js";
import type { AwardMessageRequest, AwardMessageResponse } from "./api/types.js";
import { commands } from "./commands/index.js";
import { handleButton } from "./handlers/button.js";
import { handleSelectMenu } from "./handlers/select.js";
import { PollerManager } from "./services/poller-manager.js";
import { assignJoinRole } from "./services/join-role.js";
import { initSettingsService, getSettingsService } from "./services/settings.js";
import { registerCommands } from "./services/registry.js";
import { isRegisteredTenant, requireRegisteredTenant } from "./services/tenant-gate.js";
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

  // Unscoped API client. Every call that touches tenant data must go through a
  // `withGuild(...)` copy of it: the backend resolves the tenant database from
  // the `X-Guild-Id` header and rejects an unscoped request with a 400 (see
  // apps/backend/src/tenant.rs). Only the tenant-status lookup and the
  // onboarding endpoints are safe to call unscoped.
  const api = new ApiClient(config.BACKEND_URL, config.BOT_API_SECRET);
  // Channel/role IDs now live in the backend's admin Settings instead of this
  // process's own env vars — see services/settings.ts. One cache per guild.
  initSettingsService(api);

  // Slash commands are registered per guild on ready / GuildCreate.

  // Message Content is a privileged intent that must be enabled in the Discord Developer Portal.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
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
        const guildApi = await requireRegisteredTenant(interaction, api);
        if (!guildApi) {
          return;
        }
        await command.execute(interaction, guildApi);
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
      if (!interaction.guildId) return;
      await handleButton(interaction, api.withGuild(interaction.guildId));
      return;
    }

    // Select menu interactions
    if (interaction.isStringSelectMenu()) {
      if (!interaction.guildId) return;
      await handleSelectMenu(interaction, api.withGuild(interaction.guildId));
      return;
    }
  });

  // One poller per registered tenant guild. Created before the ready handler so
  // GuildCreate can reach it, started once the guild cache is populated.
  const pollers = new PollerManager(client, api, config.POLL_INTERVAL_MS);

  client.on(Events.GuildCreate, (guild) => {
    void registerCommands(guild.id).catch((err: unknown) => {
      console.error(`[Bot] Failed to register commands for ${guild.id}:`, err);
    });
    void pollers.ensure(guild.id).catch((err: unknown) => {
      console.error(`[Bot] Failed to start poller for ${guild.id}:`, err);
    });
  });

  client.on(Events.GuildDelete, (guild) => {
    pollers.forget(guild.id);
  });

  client.on(Events.GuildMemberAdd, (member) => {
    const guildId = member.guild.id;
    void isRegisteredTenant(api, guildId)
      .then((registered) =>
        registered
          ? getSettingsService(guildId)
              .get()
              .then((guildSettings) => assignJoinRole(member, guildSettings))
          : undefined,
      )
      .catch((err: unknown) => {
        console.error("[Bot] Base guild role assignment failed:", err);
      });
  });

  // ── Message XP (fire-and-forget; never reply in-channel) ─────────────────
  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content) return;

    const body: AwardMessageRequest = {
      discord_id: message.author.id,
      message_id: message.id,
      channel_id: message.channelId,
      length: message.content.length,
    };

    const guildId = message.guild.id;
    void isRegisteredTenant(api, guildId)
      .then((registered) =>
        registered
          ? api
              .withGuild(guildId)
              .post<AwardMessageResponse>(
                "api/progression/award/message",
                body,
                message.author.id,
              )
          : undefined,
      )
      .catch((err: unknown) => {
        console.error("[Bot] Message XP award failed:", err);
      });
  });


  // ── Ready handler ────────────────────────────────────────────────────────
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`✅ Logged in as ${readyClient.user.tag}`);

    for (const guildId of readyClient.guilds.cache.keys()) {
      void registerCommands(guildId).catch((err: unknown) => {
        console.error(`[Bot] Failed to register commands for ${guildId}:`, err);
      });
    }

    // Start one poller per registered tenant guild, then keep re-checking:
    // a guild becomes a tenant on the website, which produces no Discord event.
    void pollers.reconcile().catch((err: unknown) => {
      console.error("[Bot] Initial poller reconciliation failed:", err);
    });
    pollers.start();

    // Graceful shutdown
    const shutdown = (): void => {
      console.log("[Bot] Shutting down…");
      pollers.stop();
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

// Defense-in-depth: an unhandled promise rejection anywhere in the process
// (e.g. a missed `await`/`.catch()` in a command or handler) would otherwise
// crash the whole bot. Log it and keep running instead.
process.on("unhandledRejection", (reason) => {
  console.error("[Bot] Unhandled rejection:", reason);
});

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
