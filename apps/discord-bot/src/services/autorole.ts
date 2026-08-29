import { PermissionsBitField, type GuildMember } from "discord.js";
import type { SettingsService } from "./settings.js";

/** Assigns the configured role to a human member without allowing one Discord failure to stop the bot. */
export async function assignAutoRole(
  member: GuildMember,
  settings: SettingsService,
): Promise<void> {
  if (member.user.bot) return;

  let roleId: string | null;
  try {
    roleId = await settings.autoRoleId();
  } catch (error) {
    console.error("[AutoRole] Failed to load configuration:", error);
    return;
  }

  if (!roleId) return;

  const role =
    member.guild.roles.cache.get(roleId) ??
    (await member.guild.roles.fetch(roleId).catch((error: unknown) => {
      console.error(`[AutoRole] Failed to fetch role ${roleId}:`, error);
      return null;
    }));

  if (!role) {
    console.error(`[AutoRole] Configured role ${roleId} was not found in the guild.`);
    return;
  }

  if (role.id === member.guild.id || role.managed) {
    console.error(`[AutoRole] Configured role ${roleId} cannot be assigned.`);
    return;
  }

  const botMember = member.guild.members.me;
  if (!botMember) {
    console.error("[AutoRole] Bot member is unavailable; cannot verify role hierarchy.");
    return;
  }

  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.error("[AutoRole] Bot is missing the Manage Roles permission.");
    return;
  }

  if (role.position >= botMember.roles.highest.position) {
    console.error(`[AutoRole] Role ${roleId} is not below the bot's highest role.`);
    return;
  }

  if (member.roles.cache.has(role.id)) return;

  try {
    await member.roles.add(role, "Configured AutoRole");
    console.log(`[AutoRole] Assigned ${role.name} (${role.id}) to ${member.user.tag}.`);
  } catch (error) {
    console.error(`[AutoRole] Failed to assign role ${roleId} to ${member.user.tag}:`, error);
  }
}
