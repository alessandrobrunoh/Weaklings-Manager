import assert from "node:assert/strict";
import test from "node:test";
import {
  buildsForSignupRole,
  buildSignupRoleOptions,
  selectableSignupBuilds,
  signupRoles,
} from "./event-signup.js";
import type { EventSignupBuildOption } from "../api/types.js";

function build(
  build_id: number,
  name: string,
  role: EventSignupBuildOption["role"],
  quantity: number,
  availability: EventSignupBuildOption["availability"] = "allowed",
): EventSignupBuildOption {
  return { build_id, name, role, quantity, weapon_key: null, weapon_name: null, availability };
}

test("prospective signup builds expose roles and builds introduced by an expansion", () => {
  const prospectiveBuilds = [build(1, "Base DPS", "dps", 10), build(2, "Expansion Tank", "tank", 5)];

  assert.deepEqual(signupRoles(prospectiveBuilds), ["dps", "tank"]);
  assert.deepEqual(buildsForSignupRole(prospectiveBuilds, "tank"), [
    build(2, "Expansion Tank", "tank", 5),
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

test("only builds the member may pick reach the signup menus", () => {
  const builds = [
    build(1, "Hallowfall", "healer", 2),
    build(2, "Polehammer", "tank", 1, "not_declared"),
    build(3, "Spirithunter", "dps", 4, "locked"),
  ];

  const selectable = selectableSignupBuilds(builds);
  assert.deepEqual(selectable.map((entry) => entry.build_id), [1]);
  // A role whose every build is blocked disappears; Fill is always offered on top.
  assert.deepEqual(signupRoles(selectable), ["healer"]);
});
