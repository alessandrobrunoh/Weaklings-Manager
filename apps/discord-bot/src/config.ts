import { z } from "zod";

const Env = z.object({
  /** Discord bot token from the Developer Portal. */
  DISCORD_BOT_TOKEN: z.string().min(1),
  /** Discord Application Client ID. */
  DISCORD_CLIENT_ID: z.string().min(1),
  /** The Discord Guild (server) ID to register slash commands in. */
  DISCORD_GUILD_ID: z.string().min(1),
  /** Base URL of the Albion Guild Manager backend. */
  BACKEND_URL: z.string().url().default("http://localhost:3000"),
  /**
   * Shared secret that the backend uses to authenticate bot requests.
   * Set BOT_API_SECRET in the backend env too — it will validate this header.
   */
  BOT_API_SECRET: z.string().min(1),
  /** Channel ID where new events are announced automatically. */
  DISCORD_EVENTS_CHANNEL_ID: z.string().min(1),
  /** Channel ID where new battles are posted automatically. */
  DISCORD_BATTLES_CHANNEL_ID: z.string().min(1),
  /** Role ID to ping when announcing, reminding, and starting events. */
  EVENT_ROLE_ID: z.string().optional(),
  /** Legacy role ID env kept for deployments that have not migrated yet. */
  EVENT_PING_ROLE_ID: z.string().optional(),
  /** How often (ms) the polling service checks for new events/battles. */
  POLL_INTERVAL_MS: z.coerce.number().default(60_000),
});

export type Config = z.infer<typeof Env>;

/**
 * Centralizes the event role lookup so announcement code does not care which
 * deployment variable is currently used. The legacy fallback avoids breaking
 * existing containers while `EVENT_ROLE_ID` becomes the readable name for new
 * deployments.
 *
 * @example
 * const eventRoleId = getEventRoleId(config);
 * if (eventRoleId) await channel.send(`<@&${eventRoleId}>`);
 */
export function getEventRoleId(envConfig: Config): string | undefined {
  return envConfig.EVENT_ROLE_ID ?? envConfig.EVENT_PING_ROLE_ID;
}

function loadConfig(): Config {
  const result = Env.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment configuration:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
