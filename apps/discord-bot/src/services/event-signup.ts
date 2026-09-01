import type { BuildRole } from "../api/types.js";

export const FILL_SIGNUP_VALUE = "fill";

export type SignupRoleValue = BuildRole | typeof FILL_SIGNUP_VALUE;

const BUILD_ROLE_LABELS: Record<BuildRole, string> = {
  healer: "🛡️ Healer",
  tank: "🪓 Tank",
  dps: "⚔️ DPS",
  support: "✨ Support",
  battle_mount: "🐴 Battle Mount",
  brawler: "🥊 Brawler",
};

export interface SignupRoleOption {
  label: string;
  value: SignupRoleValue;
  description?: string;
}

/** Builds the first-stage Discord signup menu, with the unlimited Fill role first. */
export function buildSignupRoleOptions(roles: readonly BuildRole[]): SignupRoleOption[] {
  return [
    {
      label: "Fill — any role / build",
      value: FILL_SIGNUP_VALUE,
      description: "I can play whatever the comp needs.",
    },
    ...roles.map((role) => ({
      label: BUILD_ROLE_LABELS[role],
      value: role,
    })),
  ];
}
