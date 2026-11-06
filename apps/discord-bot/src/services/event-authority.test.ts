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
  it("lets the owner through when the endpoint confirms ownership", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi({ is_organizer: true, can_manage: true, required_permission: "events.edit" }),
      7,
    );
    assert.equal(allowed, true);
    assert.equal(interaction.replies.length, 0);
  });

  it("lets a manager through when the endpoint confirms permission", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi({ is_organizer: false, can_manage: true, required_permission: "events.edit" }),
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

  it("refuses a member the backend could not verify, without changing the event", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi(new ApiError(403, "member_inactive")),
      7,
    );
    assert.equal(allowed, false);
    const payload = interaction.replies[0] as {
      embeds: Array<{ data: { title?: string; description?: string } }>;
    };
    assert.match(payload.embeds[0].data.title ?? "", /Unable to Verify Event Authority/);
    assert.match(payload.embeds[0].data.description ?? "", /no event changes were made/);
  });

  it("fails closed with a clear error when the authority endpoint is missing", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi(new ApiError(404, "Not Found")),
      7,
    );
    assert.equal(allowed, false);
    const payload = interaction.replies[0] as {
      embeds: Array<{ data: { title?: string; description?: string } }>;
    };
    assert.match(payload.embeds[0].data.title ?? "", /Unable to Verify/);
    assert.match(payload.embeds[0].data.description ?? "", /no event changes were made/i);
  });

  it("fails closed when the authority endpoint forbids the request", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi(new ApiError(403, "Forbidden")),
      7,
    );
    assert.equal(allowed, false);
    const payload = interaction.replies[0] as {
      embeds: Array<{ data: { title?: string } }>;
    };
    assert.match(payload.embeds[0].data.title ?? "", /Unable to Verify/);
  });

  it("fails closed on an unverifiable authority response", async () => {
    const interaction = stubInteraction();
    const allowed = await ensureEventManagementAllowed(
      interaction,
      stubApi({
        is_organizer: false,
        can_manage: "yes",
        required_permission: "events.edit",
      } as unknown as EventManagementAuthorityView),
      7,
    );
    assert.equal(allowed, false);
    assert.equal(interaction.replies.length, 1);
  });
});
