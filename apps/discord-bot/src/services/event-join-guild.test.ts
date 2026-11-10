import assert from "node:assert/strict";
import test from "node:test";
import type { StringSelectMenuInteraction } from "discord.js";
import { ApiError, type ApiClient } from "../api/client.js";
import {
  execute as executeEventJoin,
} from "../commands/event-join.js";
import { handleSelectMenu } from "../handlers/select.js";
import { eventJoinCopy } from "./event-join-copy.js";
import {
  buildBuildSelectCustomId,
  buildGuildSelectCustomId,
  buildRoleSelectCustomId,
  participatePath,
  resolveJoinGuilds,
} from "./event-join-guild.js";
import { forgetTenantStatus } from "./tenant-gate.js";

interface ReplyPayload {
  embeds: Array<{ data: { title?: string; description?: string } }>;
  components?: any;
}

let guildSeq = 0;

function makeApi(routes: {
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
}): ApiClient & {
  guildId: string;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const guildId = `join-guild-test-${++guildSeq}`;
  forgetTenantStatus(guildId);
  return {
    guildId,
    calls,
    async get(path: string) {
      calls.push({ method: "get", path });
      if (path === "api/users/me") return {};
      const result = routes.get?.(path);
      if (result === undefined) throw new Error(`Unexpected GET ${path}`);
      return result;
    },
    async post(path: string, body: unknown) {
      calls.push({ method: "post", path, body });
      const result = routes.post?.(path, body);
      if (result === undefined) throw new Error(`Unexpected POST ${path}`);
      return result;
    },
  } as unknown as ApiClient & { guildId: string; calls: typeof calls };
}

function guildStatusApi(kind: "guild" | "alliance", guilds: unknown, routes: {
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
} = {}) {
  return makeApi({
    ...routes,
    get: (path) => {
      if (path.includes("/status")) {
        return { id: "t", registered: true, status: "active", name: "T", kind };
      }
      if (path.endsWith("/participation-guilds")) return guilds;
      return routes.get?.(path);
    },
  });
}

function makeSelectInteraction(
  customId: string,
  values: string[],
): { interaction: StringSelectMenuInteraction; replies: ReplyPayload[] } {
  const replies: ReplyPayload[] = [];
  return {
    replies,
    interaction: {
      customId,
      values,
      locale: "en",
      user: { id: "424242" },
      guildId: "select-test-guild",
      guild: null,
      channel: { id: "chan-1", messages: { fetch: async () => null } },
      deferUpdate: async () => undefined,
      editReply: async (payload: ReplyPayload) => {
        replies.push(payload);
        return payload;
      },
    } as unknown as StringSelectMenuInteraction,
  };
}

const organizedEvent = {
  id: 5,
  title: "Avalonian Raid",
  status: "scheduled",
  event_kind: "organized",
  participants: [],
};

const signupOptions = {
  active_comp_id: 1,
  active_comp_name: "Comp",
  active_comp_capacity: 10,
  is_already_registered: false,
  builds: [
    { build_id: 10, name: "Great Fire", role: "dps", quantity: 2 },
    { build_id: 11, name: "Grail", role: "healer", quantity: 1 },
  ],
};

/* ------------------------- attribution resolution ------------------------- */

test("resolveJoinGuilds: guild tenant fixes attribution without asking the backend", async () => {
  const api = guildStatusApi("guild", [
    { tenant_id: "g1", name: "One" },
    { tenant_id: "g2", name: "Two" },
  ]);
  const result = await resolveJoinGuilds(api, api.guildId, 5, "424242");
  assert.equal(result.kind, "fixed");
  assert.ok(
    api.calls.every((call) => !call.path.includes("participation-guilds")),
    "guild tenant must not prompt or send a guild choice",
  );
});

test("resolveJoinGuilds: alliance tenant with zero guilds reports none", async () => {
  const api = guildStatusApi("alliance", []);
  assert.equal((await resolveJoinGuilds(api, api.guildId, 5, "424242")).kind, "none");
});

test("resolveJoinGuilds: a 409 (caller in no active guild) reports none instead of failing", async () => {
  const api = makeApi({
    get: (path) => {
      if (path.includes("/status")) return { id: "t", registered: true, status: "active", name: "T", kind: "alliance" };
      if (path.endsWith("/participation-guilds")) throw new ApiError(409, "no active guild");
      return undefined;
    },
  });
  assert.equal((await resolveJoinGuilds(api, api.guildId, 5, "424242")).kind, "none");
});

test("resolveJoinGuilds: alliance tenant with one guild resolves automatically", async () => {
  const api = guildStatusApi("alliance", [{ tenant_id: "g1", name: "Only Guild" }]);
  const result = await resolveJoinGuilds(api, api.guildId, 5, "424242");
  assert.deepEqual(result, {
    kind: "resolved",
    guildTenantId: "g1",
    guildName: "Only Guild",
  });
});

test("resolveJoinGuilds: alliance tenant with several guilds requires a choice", async () => {
  const api = guildStatusApi("alliance", [
    { tenant_id: "g1", name: "Alpha" },
    { tenant_id: "g2", name: "Beta" },
  ]);
  const result = await resolveJoinGuilds(api, api.guildId, 5, "424242");
  assert.equal(result.kind, "choice");
  if (result.kind === "choice") assert.equal(result.guilds.length, 2);
});

test("resolveJoinGuilds propagates backend failures", async () => {
  const api = makeApi({
    get: (path) => {
      if (path.includes("/status")) {
        return { id: "t", registered: true, status: "active", name: "T", kind: "alliance" };
      }
      throw new Error("boom");
    },
  });
  await assert.rejects(() => resolveJoinGuilds(api, api.guildId, 5, "424242"), /boom/);
});

/* ------------------------------ pure helpers ------------------------------ */

test("participatePath adds the guild query parameter only when attributed", () => {
  assert.equal(participatePath(5), "api/events/5/participate");
  assert.equal(participatePath(5, null), "api/events/5/participate");
  assert.equal(
    participatePath(5, "g1"),
    "api/events/5/participate?guild_tenant_id=g1",
  );
});

test("join custom ids carry the guild segment, empty when unattributed", () => {
  assert.equal(
    buildRoleSelectCustomId(5, "card-1", "g1"),
    "event:join_role:5:card-1:g1",
  );
  assert.equal(
    buildBuildSelectCustomId(5, "card-1", null),
    "event:join_build:5:card-1:",
  );
  assert.equal(
    buildGuildSelectCustomId(5, "card-1", "flash"),
    "event:join_guild:5:card-1:flash",
  );
});

test("event join copy exists in English and Italian", () => {
  assert.match(eventJoinCopy("en", "noGuildBody"), /active guild membership/);
  assert.match(eventJoinCopy("it", "noGuildBody"), /iscrizione attiva/);
  assert.match(eventJoinCopy("en", "chooseGuildBody", { id: 5 }), /#5/);
});

/* ------------------------------ /event-join ------------------------------- */

function makeCommandInteraction(): {
  interaction: any;
  replies: ReplyPayload[];
} {
  const replies: ReplyPayload[] = [];
  return {
    replies,
    interaction: {
      locale: "en",
      user: { id: "424242" },
      guildId: "cmd-guild",
      options: { getInteger: () => 5 },
      deferReply: async () => undefined,
      editReply: async (payload: ReplyPayload) => {
        replies.push(payload);
        return payload;
      },
    },
  };
}

test("/event-join on an alliance Discord with no guild explains the membership requirement", async () => {
  forgetTenantStatus("cmd-guild");
  const api = guildStatusApi("alliance", [], {
    get: (path) => {
      if (path === "api/events/5") return organizedEvent;
      return undefined;
    },
  });
  const { interaction, replies } = makeCommandInteraction();
  await executeEventJoin(interaction, api);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].embeds[0].data.title?.endsWith("No Active Guild"));
  assert.equal(replies[0].components, undefined);
});

test("/event-join on an alliance Discord with several guilds shows a guild select first", async () => {
  forgetTenantStatus("cmd-guild");
  const api = guildStatusApi(
    "alliance",
    [
      { tenant_id: "g1", name: "Alpha" },
      { tenant_id: "g2", name: "Beta" },
    ],
    { get: (path) => (path === "api/events/5" ? organizedEvent : undefined) },
  );
  const { interaction, replies } = makeCommandInteraction();
  await executeEventJoin(interaction, api);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].embeds[0].data.title?.endsWith("Select Guild"));
  const menu = replies[0].components[0].components[0];
  assert.equal(menu.data.custom_id, "event:join_guild:5::");
  assert.deepEqual(
    menu.options.map((o: any) => o.data.value),
    ["g1", "g2"],
  );
});

test("/event-join on a guild Discord keeps the plain manage buttons", async () => {
  forgetTenantStatus("cmd-guild");
  const api = guildStatusApi("guild", [], {
    get: (path) => (path === "api/events/5" ? organizedEvent : undefined),
  });
  const { interaction, replies } = makeCommandInteraction();
  await executeEventJoin(interaction, api);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].embeds[0].data.title?.endsWith("Event Registration"));
  assert.ok(replies[0].components.length > 0);
});

/* ---------------------------- select-menu chain ---------------------------- */

test("guild choice followed by role selection chains the guild into the role menu", async () => {
  const api = guildStatusApi("alliance", [], {
    get: (path) => {
      if (path === "api/events/5/signup-options") return signupOptions;
      return undefined;
    },
  });
  const { interaction, replies } = makeSelectInteraction(
    "event:join_guild:5:card-1:",
    ["g1"],
  );
  await handleSelectMenu(interaction, api);
  assert.equal(replies.length, 1);
  const menu = replies[0].components[0].components[0];
  assert.equal(menu.data.custom_id, "event:join_role:5:card-1:g1");
});

test("guild choice with a pending build submits guild and build together, once", async () => {
  const api = guildStatusApi("alliance", [], {
    get: (path) => (path === "api/events/5" ? organizedEvent : undefined),
    post: () => organizedEvent,
  });
  const { interaction, replies } = makeSelectInteraction(
    "event:join_guild:5:card-1:11",
    ["g1"],
  );
  await handleSelectMenu(interaction, api);
  const posts = api.calls.filter((call) => call.method === "post");
  assert.deepEqual(posts, [
    {
      method: "post",
      path: "api/events/5/participate?guild_tenant_id=g1",
      body: { primary_build_id: 11 },
    },
  ]);
  assert.ok(replies[0].embeds[0].data.title?.endsWith("Signed Up For Event"));
});

test("join_build with a guild segment submits one participate call with the query", async () => {
  const api = guildStatusApi("alliance", [], {
    get: (path) => (path === "api/events/5" ? organizedEvent : undefined),
    post: () => organizedEvent,
  });
  const { interaction, replies } = makeSelectInteraction(
    "event:join_build:5:card-1:g1",
    ["11"],
  );
  await handleSelectMenu(interaction, api);
  const posts = api.calls.filter((call) => call.method === "post");
  assert.deepEqual(posts, [
    {
      method: "post",
      path: "api/events/5/participate?guild_tenant_id=g1",
      body: { primary_build_id: 11 },
    },
  ]);
  assert.ok(replies[0].embeds[0].data.title?.endsWith("Signed Up For Event"));
  assert.deepEqual(replies[0].components, []);
});

test("join_build without a guild segment (guild tenant) keeps the plain endpoint", async () => {
  const api = guildStatusApi("guild", [], {
    get: (path) => (path === "api/events/5" ? organizedEvent : undefined),
    post: () => organizedEvent,
  });
  const { interaction } = makeSelectInteraction(
    "event:join_build:5:card-1:",
    ["11"],
  );
  await handleSelectMenu(interaction, api);
  const posts = api.calls.filter((call) => call.method === "post");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "api/events/5/participate");
});
