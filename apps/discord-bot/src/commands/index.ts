import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';

export interface BotCommand {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void>;
}


// Import all commands
import * as events from './events.js';
import * as eventCreate from './event-create.js';
import * as eventJoin from './event-join.js';
import * as eventLeave from './event-leave.js';
import * as eventStart from './event-start.js';
import * as eventStop from './event-stop.js';
import * as balance from './balance.js';
import * as balanceRequest from './balance-request.js';
import * as battles from './battles.js';
import * as users from './users.js';
import * as link from './link.js';
import * as player from './player.js';
import * as me from './me.js';
import * as eventRoster from './event-roster.js';
import * as roster from './roster.js';
import * as rank from './rank.js';
import * as leaderboard from './leaderboard.js';
import * as vod from './vod.js';
import * as xp from './xp.js';
import * as warn from './warn.js';
import * as warns from './warns.js';
import * as unwarn from './unwarn.js';
import * as applicationsPanel from './applications-panel.js';

/**
 * All registered bot commands.
 * Each key is the command name used for dispatch.
 */
export const commands = new Map<string, BotCommand>([
  ['events', events],
  ['event-create', eventCreate],
  ['event-join', eventJoin],
  ['event-leave', eventLeave],
  ['event-start', eventStart],
  ['event-stop', eventStop],
  ['balance', balance],
  ['balance-request', balanceRequest],
  ['battles', battles],
  ['users', users],
  ['link', link],
  ['player', player],
  ['me', me],
  ['event-roster', eventRoster],
  ['roster', roster],
  ['rank', rank],
  ['leaderboard', leaderboard],
  ['vod', vod],
  ['xp', xp],
  ['warn', warn],
  ['warns', warns],
  ['unwarn', unwarn],
  ['applications-panel', applicationsPanel],
]);
