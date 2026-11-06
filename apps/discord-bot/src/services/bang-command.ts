import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type ModalBuilder,
  type User,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BotCommand } from '../commands/index.js';
import { createResponseEmbed } from '../embeds/theme.js';
import { executeSlashCommand } from './command-gate.js';

/** Every slash command can also be invoked as `!command arg1 arg2 …`. */
export const BANG_PREFIX = '!';

/**
 * Button customId that re-opens a modal requested from a bang command.
 *
 * `showModal` needs an interaction token, and a plain chat message has none —
 * so the adapter answers with this button, whose click *is* an interaction and
 * can open the very same modal. See `BangInteractionAdapter.showModal`.
 */
export const BANG_MODAL_BUTTON_ID = 'bang:open-modal';

/** Modals parked on the bot's reply, keyed by that reply's message id. */
const pendingModals = new Map<string, ModalBuilder>();

/** Returns (and forgets) the modal parked on a bang-command reply. */
export function takePendingBangModal(messageId: string): ModalBuilder | null {
  const modal = pendingModals.get(messageId) ?? null;
  pendingModals.delete(messageId);
  return modal;
}

export interface ParsedBangCommand {
  name: string;
  args: string[];
}

/**
 * Splits a bang line into name + positional args.
 *
 * Returns null for anything that is not a bang command (no prefix, bare `!`,
 * or a name glued to trailing punctuation). Quoted args keep their spaces.
 */
export function parseBangCommand(content: string): ParsedBangCommand | null {
  if (!content.startsWith(BANG_PREFIX)) return null;
  const match = /^([A-Za-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(content.slice(BANG_PREFIX.length));
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: match[2] ? tokenizeArgs(match[2]) : [],
  };
}

/** Whitespace-separated tokens; `"…"` / `'…'` group multi-word values. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    const quote = input[i] === '"' || input[i] === "'" ? input[i] : null;
    if (quote) {
      i += 1;
      let value = '';
      while (i < input.length && input[i] !== quote) {
        if (
          input[i] === '\\' &&
          i + 1 < input.length &&
          (input[i + 1] === quote || input[i + 1] === '\\')
        ) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      if (i < input.length) i += 1; // closing quote
      tokens.push(value);
    } else {
      const start = i;
      while (i < input.length && !/\s/.test(input[i])) i += 1;
      tokens.push(input.slice(start, i));
    }
  }
  return tokens;
}

interface JsonOption {
  name: string;
  type: number;
  required?: boolean;
  options?: JsonOption[];
}

/** The declared options of a command, from the same builder Discord registers from. */
function commandOptions(command: BotCommand): JsonOption[] {
  const json = (
    command.data as unknown as { toJSON(): { options?: JsonOption[] } }
  ).toJSON();
  return json.options ?? [];
}

const USER_MENTION = /^<@!?(\d+)>$/;
const ROLE_MENTION = /^<@&(\d+)>$/;
const CHANNEL_MENTION = /^<#(\d+)>$/;

interface ResolvedOption {
  type: number;
  value: unknown;
}

/** Coerces one positional token into the declared option type, or null. */
function coerceArg(raw: string, type: number, message: Message): ResolvedOption | null {
  switch (type) {
    case ApplicationCommandOptionType.String:
      return { type, value: raw };
    case ApplicationCommandOptionType.Integer: {
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? null : { type, value: n };
    }
    case ApplicationCommandOptionType.Number: {
      const n = Number.parseFloat(raw);
      return Number.isNaN(n) ? null : { type, value: n };
    }
    case ApplicationCommandOptionType.Boolean: {
      const normalized = raw.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return { type, value: true };
      if (['false', '0', 'no', 'off'].includes(normalized)) return { type, value: false };
      return null;
    }
    case ApplicationCommandOptionType.User: {
      const id = USER_MENTION.test(raw)
        ? (USER_MENTION.exec(raw) as RegExpExecArray)[1]
        : /^\d+$/.test(raw)
          ? raw
          : null;
      if (!id) return null;
      // The mention is in the invoking message, so the cache almost always has it;
      // the synthetic fallback still carries the id every consumer reads.
      const user = message.mentions.users.get(id);
      return {
        type,
        value:
          user ??
          ({ id, username: 'unknown', displayName: 'Unknown', bot: false } as unknown as User),
      };
    }
    case ApplicationCommandOptionType.Role:
    case ApplicationCommandOptionType.Channel:
    case ApplicationCommandOptionType.Mentionable: {
      const mention =
        USER_MENTION.exec(raw) ?? ROLE_MENTION.exec(raw) ?? CHANNEL_MENTION.exec(raw);
      const id = mention ? mention[1] : /^\d+$/.test(raw) ? raw : null;
      return id ? { type, value: id } : null;
    }
    default:
      // Attachments have no text form; leave them unset (handlers treat them as optional).
      return null;
  }
}

interface FilledOptions {
  values: Map<string, ResolvedOption>;
  subcommand: string | null;
  subcommandGroup: string | null;
}

/**
 * Maps positional tokens onto the command's declared options, in order.
 *
 * For subcommands (`/xp add …`) the first token selects the subcommand, then
 * its options fill from the remaining tokens. Extra tokens are ignored.
 */
function fillOptions(options: JsonOption[], args: string[], message: Message): FilledOptions {
  const filled: FilledOptions = {
    values: new Map(),
    subcommand: null,
    subcommandGroup: null,
  };
  let i = 0;

  const leaves = options.filter(
    (opt) =>
      opt.type !== ApplicationCommandOptionType.Subcommand &&
      opt.type !== ApplicationCommandOptionType.SubcommandGroup,
  );
  if (leaves.length === options.length) {
    fillLeaves(options, args, message, filled);
    return filled;
  }

  // Subcommand (or group) dispatch: the first token names it.
  const token = args[i++]?.toLowerCase();
  const chosen = options.find((opt) => opt.name === token);
  if (!chosen) return filled; // unknown subcommand: nothing resolves

  if (chosen.type === ApplicationCommandOptionType.SubcommandGroup) {
    filled.subcommandGroup = chosen.name;
    const subToken = args[i++]?.toLowerCase();
    const sub = chosen.options?.find((opt) => opt.name === subToken);
    if (!sub) return filled;
    filled.subcommand = sub.name;
    fillLeaves(sub.options ?? [], args.slice(i), message, filled);
    return filled;
  }

  filled.subcommand = chosen.name;
  fillLeaves(chosen.options ?? [], args.slice(i), message, filled);
  return filled;
}

function fillLeaves(
  options: JsonOption[],
  args: string[],
  message: Message,
  filled: FilledOptions,
): void {
  let i = 0;
  for (const opt of options) {
    if (i >= args.length) break; // missing option → handler default/null, like an omitted slash option
    const resolved = coerceArg(args[i], opt.type, message);
    i += 1;
    if (resolved) filled.values.set(opt.name, resolved);
  }
}

/** Payload without the ephemeral flag, which has no message-context equivalent. */
function stripEphemeral(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) return {};
  const { flags: _flags, ...rest } = payload;
  return rest;
}

/**
 * A `ChatInputCommandInteraction` shaped onto a chat message.
 *
 * Discord only ephemerals interaction replies, so from a message context every
 * reply — including the ones the slash flow marks Ephemeral — is sent as a
 * normal reply that pings the invoker, which is the closest equivalent.
 * This implements exactly the surface the command handlers and the shared
 * gates use (reply/defer/edit/followUp/options/user/member/guildId/locale);
 * `asChatInput()` hands it to `executeSlashCommand` so every gate — tenant
 * kind, website account, per-command permissions — runs the identical code.
 */
export class BangCommandInteractionAdapter {
  readonly commandName: string;
  readonly user: User;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly locale: string | null;
  readonly client: Message['client'];
  readonly channel: Message['channel'] | null;
  readonly member: Message['member'];
  readonly guild: Message['guild'] | null;
  deferred = false;
  replied = false;
  private readonly optionsData: FilledOptions;
  private sent: Message | null = null;

  constructor(
    private readonly message: Message,
    command: BotCommand,
    name: string,
    args: string[],
  ) {
    this.commandName = name;
    this.user = message.author;
    this.channelId = message.channelId;
    this.guildId = message.guildId;
    this.locale = message.guild?.preferredLocale ?? null;
    this.client = message.client;
    this.channel = message.channel;
    this.member = message.member;
    this.guild = message.guild;
    this.optionsData = fillOptions(commandOptions(command), args, message);
  }

  /** Cast is safe for the shared gate path: it only reads the fields above. */
  asChatInput(): ChatInputCommandInteraction {
    return this as unknown as ChatInputCommandInteraction;
  }

  readonly options = {
    get: (name: string) => {
      const resolved = this.optionsData.values.get(name);
      return resolved ? { name, type: resolved.type, value: resolved.value } : null;
    },
    getString: (name: string) => this.typed<string>(name),
    getInteger: (name: string) => this.typed<number>(name),
    getNumber: (name: string) => this.typed<number>(name),
    getBoolean: (name: string) => this.typed<boolean>(name),
    getUser: (name: string) => this.typed<User>(name),
    // A user option names a server member only when the mention carries the guild member.
    getMember: (name: string) => this.memberFor(name),
    getChannel: (name: string) => this.typed(name),
    getRole: (name: string) => this.typed(name),
    getMentionable: (name: string) => this.typed(name),
    getAttachment: () => null,
    getSubcommand: () => this.optionsData.subcommand,
    getSubcommandGroup: () => this.optionsData.subcommandGroup,
    getFocused: () => null,
  };

  private typed<T>(name: string): T | null {
    return (this.optionsData.values.get(name)?.value as T | undefined) ?? null;
  }

  /** The guild member a mention resolved to; `null` for someone outside this server. */
  private memberFor(name: string): GuildMember | null {
    const user = this.typed<User>(name);
    if (!user) return null;
    return this.message.mentions.members?.get(user.id) ?? null;
  }

  /** Bang commands only run in a guild, so the adapter is always inside one. */
  inGuild(): boolean {
    return this.guildId !== null;
  }

  async reply(payload: Record<string, unknown>): Promise<Message> {
    this.replied = true;
    this.sent = await this.message.reply({
      ...stripEphemeral(payload),
      allowedMentions: { users: [this.user.id], ...((payload.allowedMentions as object) ?? {}) },
    });
    return this.sent;
  }

  async deferReply(_payload?: Record<string, unknown>): Promise<void> {
    this.deferred = true;
    // Guild messages are always text-ish channels; the cast keeps the union happy.
    const channel = this.message.channel as { sendTyping?: () => Promise<void> };
    void channel.sendTyping?.().catch(() => undefined);
  }

  async editReply(payload: Record<string, unknown>): Promise<Message | null> {
    if (this.sent) {
      this.sent = await this.sent.edit(stripEphemeral(payload));
    } else {
      // deferReply sent nothing visible, so the first editReply is the reply.
      this.sent = await this.reply(payload);
    }
    return this.sent;
  }

  async followUp(payload: Record<string, unknown>): Promise<Message> {
    return this.message.reply({
      ...stripEphemeral(payload),
      allowedMentions: { users: [this.user.id], ...((payload.allowedMentions as object) ?? {}) },
    });
  }

  async deleteReply(): Promise<void> {
    await this.sent?.delete();
  }

  /**
   * A real modal needs an interaction token, which a chat message cannot offer.
   * Fallback: reply with a button that opens the exact same modal; the submit
   * then flows through the normal modal handler unchanged.
   */
  async showModal(modal: ModalBuilder): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(BANG_MODAL_BUTTON_ID)
        .setLabel('Open the form')
        .setStyle(ButtonStyle.Primary),
    );
    const sent = await this.reply({
      embeds: [
        createResponseEmbed(
          'info',
          'Almost there',
          'Forms need a Discord interaction — tap the button below to open it.',
          'BOT SYSTEM',
        ),
      ],
      components: [row],
    });
    pendingModals.set(sent.id, modal);
  }
}

/**
 * MessageCreate entry point for bang commands.
 *
 * Ignores bots (including this bot), non-guild messages, non-bang content, and
 * unknown command names — silently, the way Discord treats unknown slash
 * commands. Known names run through the exact same gate + handler as the
 * slash path.
 */
export async function handleBangCommand(
  message: Message,
  api: ApiClient,
  commands: Map<string, BotCommand>,
): Promise<void> {
  if (message.author.bot) return;
  if (!message.inGuild()) return;
  const parsed = parseBangCommand(message.content);
  if (!parsed) return;
  const command = commands.get(parsed.name);
  if (!command) return;

  const adapter = new BangCommandInteractionAdapter(
    message,
    command,
    parsed.name,
    parsed.args,
  );
  try {
    await executeSlashCommand(adapter.asChatInput(), api, command);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'An unexpected error occurred.';
    console.error(`[Bot] Error in !${parsed.name}:`, err);
    const embed = createResponseEmbed('error', 'Command Error', detail, 'COMMAND FAILED');
    if (adapter.replied || adapter.deferred) {
      await adapter.followUp({ embeds: [embed] });
    } else {
      await adapter.reply({ embeds: [embed] });
    }
  }
}
