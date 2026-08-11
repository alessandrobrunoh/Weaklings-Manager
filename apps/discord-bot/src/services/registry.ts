import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commands } from '../commands/index.js';

/**
 * Registers all slash commands with Discord for the configured guild.
 * This runs once at startup (guild-scoped commands update instantly).
 */
export async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.DISCORD_BOT_TOKEN);

  const commandData = [...commands.values()].map((cmd) => cmd.data.toJSON());

  console.log(`[Registry] Registering ${commandData.length} slash commands…`);

  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
    { body: commandData },
  );

  console.log('[Registry] ✅ Slash commands registered successfully.');
}
