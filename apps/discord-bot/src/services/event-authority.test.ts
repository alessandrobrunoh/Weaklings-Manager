import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, type ApiClient } from "../api/client.js";
import type { EventManagementAuthorityView } from "../api/types.js";
import { ensureEventManagementAllowed } from "./event-authority.js";

function stubInteraction() {
  const replies: unknown[] = [];
  return {
    user: { id: "member-1" },
    replies,
    async editReply(payload: unknown) {
      replies.push(payload);
    },
  };
}

function stubApi(result: EventManagementAuthorityView | ApiError): ApiClient {
  return {
    async get() {
      if (result instanceof ApiError) throw result;
      return result;
    },
  } as unknown as ApiClient;
}

describe("ensureEventManagementAllowed", () => {
  it("lets the organizer or an events-manage role through", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi({ is_organizer: true, can_manage: true, required_permission: "events.edit" }),
      7,
    );
    assert.equal(allowed, true);
    assert.equal(interaction.replies.length, 0);
  });

  it("refuses everyone else with a clear ephemeral", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi({ is_organizer: false, can_manage: false, required_permission: "events.edit" }),
      7,
    );
    assert.equal(allowed, false);
    const payload = interaction.replies[0] as {
      embeds: Array<{ data: { title?: string; description?: string } }>;
    };
    assert.match(payload.embeds[0].data.title ?? "", /Not Allowed/);
    assert.match(payload.embeds[0].data.description ?? "", /organizer/);
    assert.match(payload.embeds[0].data.description ?? "", /Events Manage/);
  });

  it("asks an unlinked Discord user to register instead of managing the event", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi(
        new ApiError(401, "Discord user member-1 has no linked account in this system."),
      ),
      7,
    );
    assert.equal(allowed, false);
    const payload = interaction.replies[0] as {
      embeds: Array<{ data: { title?: string } }>;
    };
    assert.match(payload.embeds[0].data.title ?? "", /Website Account Required/);
  });

  it("falls through when the backend has no authority endpoint yet", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi(new ApiError(404, "Not Found")),
      7,
    );
    assert.equal(allowed, true);
    assert.equal(interaction.replies.length, 0);
  });
});
