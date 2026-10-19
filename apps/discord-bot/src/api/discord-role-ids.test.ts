import assert from "node:assert/strict";
import test from "node:test";
import { discordRoleIdsFromMember } from "./discord-role-ids.js";

test("discordRoleIdsFromMember accepts raw interaction and cache-backed member roles", () => {
  assert.deepEqual(
    discordRoleIdsFromMember({
      roles: ["111111111111111111", "222222222222222222"],
    }),
    ["111111111111111111", "222222222222222222"],
  );

  assert.deepEqual(
    discordRoleIdsFromMember({
      roles: {
        cache: {
          keys: function* () {
            yield "333333333333333333";
            yield "444444444444444444";
          },
        },
      },
    }),
    ["333333333333333333", "444444444444444444"],
  );
  assert.deepEqual(discordRoleIdsFromMember(null), []);
});
