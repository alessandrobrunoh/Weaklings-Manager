import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { ApiClient } from "../api/client.js";
import type { BotCommand } from "./index.js";
import {
  executeEventThreadAction,
  type EventThreadAction,
} from "../services/event-thread-command.js";

interface ThreadActionSpec {
  name: string;
  description: string;
  action: EventThreadAction;
  buildOption?: boolean;
}

const THREAD_ACTION_SPECS: ThreadActionSpec[] = [
  {
    name: "join",
    description: "🙋 Join the event this thread belongs to",
    action: "join",
    buildOption: true,
  },
  {
    name: "leave",
    description: "🚪 Leave the event this thread belongs to",
    action: "leave",
  },
];

/**
 * Builds one thread-context command per event action. Each is the button's
 * twin: it must be used inside the event's discussion thread or forum post,
 * where the poller's thread mapping resolves the event to act on.
 */
function buildThreadActionCommand(spec: ThreadActionSpec): BotCommand {
  const builder = new SlashCommandBuilder()
    .setName(spec.name)
    .setDescription(spec.description);
  if (spec.buildOption) {
    builder.addStringOption((opt) =>
      opt
        .setName("build")
        .setDescription("Build to sign up with (exact or partial name; omit to pick from a menu)")
        .setRequired(false),
    );
  }
  return {
    data: builder,
    async execute(
      interaction: ChatInputCommandInteraction,
      api: ApiClient,
    ): Promise<void> {
      await executeEventThreadAction(interaction, api, spec.action);
    },
  };
}

export const threadActionCommands: BotCommand[] = THREAD_ACTION_SPECS.map(
  buildThreadActionCommand,
);