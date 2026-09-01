import assert from "node:assert/strict";
import test from "node:test";
import {
  buildsForSignupRole,
  buildSignupRoleOptions,
  signupRoles,
} from "./event-signup.js";

test("prospective signup builds expose roles and builds introduced by an expansion", () => {
  const prospectiveBuilds = [
    { build_id: 1, name: "Base DPS", role: "dps" as const, quantity: 10 },
    { build_id: 2, name: "Expansion Tank", role: "tank" as const, quantity: 5 },
  ];

  assert.deepEqual(signupRoles(prospectiveBuilds), ["dps", "tank"]);
  assert.deepEqual(buildsForSignupRole(prospectiveBuilds, "tank"), [
    { build_id: 2, name: "Expansion Tank", role: "tank", quantity: 5 },
  ]);
});

test("signup role options always present Fill before build roles", () => {
  assert.deepEqual(buildSignupRoleOptions([]), [
    {
      label: "Fill — any role / build",
      value: "fill",
      description: "I can play whatever the comp needs.",
    },
  ]);

  assert.deepEqual(buildSignupRoleOptions(["tank", "healer"]), [
    {
      label: "Fill — any role / build",
      value: "fill",
      description: "I can play whatever the comp needs.",
    },
    { label: "🪓 Tank", value: "tank" },
    { label: "🛡️ Healer", value: "healer" },
  ]);
});
