import { EmbedBuilder } from 'discord.js';

export const BOT_COLORS = {
  BRAND: 0xc5a059,    // Albion Gold / Bronze (#C5A059)
  SUCCESS: 0x2ecc71,  // Emerald Green
  DANGER: 0xed4245,   // Crimson Red
  WARNING: 0xfee75c,  // Amber Yellow
  INFO: 0x5865f2,     // Blurple
  DARK: 0x2b2d31,     // Discord Dark Slate
} as const;

export const GUILD_NAME = process.env['GUILD_NAME'] || 'Weaklings';

export function getGuildHeader(subCategory?: string): string {
  const gName = GUILD_NAME.toUpperCase();
  if (subCategory) {
    return `⚔️ ${gName} — ${subCategory.toUpperCase()}`;
  }
  return `⚔️ ${gName} — ALBION GUILD MANAGER`;
}

export interface BaseEmbedOptions {
  category?: string;
  title: string;
  description?: string;
  color?: number;
  footerText?: string;
}

export function createBaseEmbed(options: BaseEmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: getGuildHeader(options.category) })
    .setTitle(options.title)
    .setColor(options.color ?? BOT_COLORS.BRAND)
    .setFooter({ text: options.footerText ?? `${GUILD_NAME} • Albion Guild Manager` })
    .setTimestamp();

  if (options.description) {
    embed.setDescription(options.description);
  }

  return embed;
}

export type ResponseType = 'success' | 'error' | 'warning' | 'info';

const RESPONSE_CONFIG: Record<ResponseType, { icon: string; color: number; label: string }> = {
  success: { icon: '✅', color: BOT_COLORS.SUCCESS, label: 'SUCCESS' },
  error:   { icon: '❌', color: BOT_COLORS.DANGER,  label: 'ERROR' },
  warning: { icon: '⚠️', color: BOT_COLORS.WARNING, label: 'WARNING' },
  info:    { icon: 'ℹ️', color: BOT_COLORS.INFO,    label: 'INFO' },
};

export function createResponseEmbed(
  type: ResponseType,
  title: string,
  description: string,
  category?: string,
): EmbedBuilder {
  const cfg = RESPONSE_CONFIG[type];
  const fullTitle = `${cfg.icon} ${title}`;

  return new EmbedBuilder()
    .setAuthor({ name: getGuildHeader(category ?? cfg.label) })
    .setTitle(fullTitle)
    .setDescription(description)
    .setColor(cfg.color)
    .setFooter({ text: `${GUILD_NAME} • Albion Guild Manager` })
    .setTimestamp();
}
