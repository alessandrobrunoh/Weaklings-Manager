import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commands } from '../commands/index.js';

/**
 * Registers all slash commands with Discord for one guild.
 * Guild-scoped commands update instantly.
 */
export async function registerCommands(guildId: string): Promise<void> {
  const rest = new REST().setToken(config.DISCORD_BOT_TOKEN);

  const commandData = [...commands.values()].map((cmd) => cmd.data.toJSON());

  console.log(`[Registry] Registering ${commandData.length} slash commands in ${guildId}…`);

  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, guildId),
    { body: commandData },
  );

  console.log(`[Registry] ✅ Slash commands registered for ${guildId}.`);
}
