import assert from "node:assert/strict";
import test from "node:test";
import { buildSignupRoleOptions } from "./event-signup.js";

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
