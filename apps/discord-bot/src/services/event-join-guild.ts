import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import { fetchTenantStatus } from "./tenant-gate.js";
import { eventJoinCopy } from "./event-join-copy.js";

/** One eligible guild returned by `GET api/events/{id}/participation-guilds`. */
export interface ParticipationGuildOption {
  tenant_id: string;
  name: string;
}

/** Custom-id marker used when the signup waiting on a guild choice is a flash mass. */
export const JOIN_GUILD_PENDING_FLASH = "flash";

/**
 * How a join in the current Discord tenant should be attributed to a guild.
 *
 * - `fixed`: the Discord tenant is a guild (or unknown kind) — the backend
 *   attributes the signup to that guild; never send `guild_tenant_id`.
 * - `none`: alliance context, but the caller has no active guild membership.
 * - `resolved`: alliance context with exactly one eligible guild — automatic.
 * - `choice`: alliance context with several eligible guilds — ask first.
 */
export type JoinGuildResolution =
  | { kind: "fixed" }
  | { kind: "none" }
  | { kind: "resolved"; guildTenantId: string; guildName: string }
  | { kind: "choice"; guilds: ParticipationGuildOption[] };

/**
 * Resolves guild attribution for a signup started in `guildId`'s Discord.
 *
 * Throws on backend errors; callers render the fetch-failed copy.
 */
export async function resolveJoinGuilds(
  api: ApiClient,
  guildId: string,
  eventId: number,
  discordId: string,
): Promise<JoinGuildResolution> {
  const status = await fetchTenantStatus(api, guildId);
  if (status.kind?.toLowerCase() !== "alliance") {
    return { kind: "fixed" };
  }
  const guilds = await api.get<ParticipationGuildOption[]>(
    `api/events/${eventId}/participation-guilds`,
    discordId,
  );
  if (!guilds || guilds.length === 0) {
    return { kind: "none" };
  }
  if (guilds.length === 1) {
    return {
      kind: "resolved",
      guildTenantId: guilds[0].tenant_id,
      guildName: guilds[0].name,
    };
  }
  return { kind: "choice", guilds };
}

/** Participate endpoint with the chosen guild attribution, when one is needed. */
export function participatePath(
  eventId: number,
  guildTenantId?: string | null,
): string {
  return guildTenantId
    ? `api/events/${eventId}/participate?guild_tenant_id=${encodeURIComponent(guildTenantId)}`
    : `api/events/${eventId}/participate`;
}

/*
 * Custom-id chaining. The join flow is a chain of select menus whose custom
 * ids carry the context the next step needs: `event:<action>:<eventId>:<messageId>:<extra>`.
 * For `join_role`/`join_build` the extra segment is the chosen guild tenant id
 * (empty on guild tenants); for `join_guild` it is the pending signup mode:
 * empty for the interactive role flow, "flash", or a concrete build id.
 */

export function buildGuildSelectCustomId(
  eventId: number,
  messageId: string | null | undefined,
  pending: string,
): string {
  return `event:join_guild:${eventId}:${messageId ?? ""}:${pending ?? ""}`;
}

export function buildRoleSelectCustomId(
  eventId: number,
  messageId: string | null | undefined,
  guildTenantId?: string | null,
): string {
  return `event:join_role:${eventId}:${messageId ?? ""}:${guildTenantId ?? ""}`;
}

export function buildBuildSelectCustomId(
  eventId: number,
  messageId: string | null | undefined,
  guildTenantId?: string | null,
): string {
  return `event:join_build:${eventId}:${messageId ?? ""}:${guildTenantId ?? ""}`;
}

/** Guild-select menu row shown when an alliance signup is ambiguous. */
export function buildGuildSelectRow(
  guilds: ParticipationGuildOption[],
  eventId: number,
  messageId: string | null | undefined,
  pending: string,
  locale: string | null | undefined,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildGuildSelectCustomId(eventId, messageId, pending))
    .setPlaceholder(eventJoinCopy(locale, "chooseGuildPlaceholder"))
    .addOptions(
      guilds.map((guild) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(guild.name)
          .setValue(guild.tenant_id),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}
