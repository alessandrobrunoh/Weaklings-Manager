import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './config.js';
import { ApiClient } from './api/client.js';
import { commands } from './commands/index.js';
import { handleButton } from './handlers/button.js';
import { handleSelectMenu } from './handlers/select.js';
import { Poller } from './services/poller.js';
import { registerCommands } from './services/registry.js';
import { createResponseEmbed } from './embeds/theme.js';

/**
 * Albion Guild Manager — Discord Bot
 *
 * Entry point. Boots the discord.js client, registers slash commands,
 * wires up interaction handlers, and starts the polling service.
 */
async function main(): Promise<void> {
  console.log('🤖 Albion Guild Manager Bot starting…');

  // Create the API client (shared across all handlers)
  const api = new ApiClient(config.BACKEND_URL, config.BOT_API_SECRET);

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
        const warnEmbed = createResponseEmbed('warning', 'Unknown Command', 'Command not recognized by bot system.', 'COMMAND ERROR');
        await interaction.reply({ embeds: [warnEmbed], flags: ['Ephemeral'] });
        return;
      }

      try {
        await command.execute(interaction, api);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
        console.error(`[Bot] Error in /${interaction.commandName}:`, err);

        const errEmbed = createResponseEmbed('error', 'Command Error', message, 'COMMAND FAILED');
        const reply = { embeds: [errEmbed], flags: ['Ephemeral'] as any };
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
    const poller = new Poller(
      readyClient,
      api,
      config.DISCORD_EVENTS_CHANNEL_ID,
      config.DISCORD_BATTLES_CHANNEL_ID,
      config.POLL_INTERVAL_MS,
    );
    poller.start();

    // Graceful shutdown
    const shutdown = (): void => {
      console.log('[Bot] Shutting down…');
      poller.stop();
      readyClient.destroy();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  // ── Login ────────────────────────────────────────────────────────────────
  await client.login(config.DISCORD_BOT_TOKEN);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
