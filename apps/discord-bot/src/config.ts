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
  /** How often (ms) the polling service checks for new events/battles. */
  POLL_INTERVAL_MS: z.coerce.number().default(60_000),
  /** Writable directory used to persist poller checkpoints between restarts. */
  POLLER_STATE_DIR: z.string().min(1).default("/app/data"),
  /**
   * Guild name used in embed headers/footers and to determine win/loss in
   * battle reports. Single source of truth — read this instead of
   * `process.env['GUILD_NAME']` directly.
   */
  GUILD_NAME: z.string().min(1).default("Weaklings"),
});

export type Config = z.infer<typeof Env>;

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
