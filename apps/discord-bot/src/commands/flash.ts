import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import { flashCopy } from "../services/flash-copy.js";
import type { BotMessageCommand } from "./index.js";

export const FLASH_MODAL_ID = "flash:create";
export const FLASH_WHAT_FIELD = "flash_what";
export const FLASH_WHEN_FIELD = "flash_when";
export const FLASH_NOTES_FIELD = "flash_notes";
export const FLASH_MESSAGE_COMMAND_NAME = "Flash mass";

export const data = new SlashCommandBuilder()
  .setName("flash")
  .setDescription(
    "⚡ Launch a flash mass — join/leave only, no comp (requires the flash mass channel)",
  )
  .setDescriptionLocalizations({
    it: "⚡ Crea una massa flash: solo partecipa/esci, senza comp.",
  });

/**
 * Shows the 3-field modal. Creation happens on submit (see `handlers/modal.ts`),
 * so a cancelled form costs nothing — not even a backend call.
 *
 * Who may launch is a permission question and stays server-side: the backend
 * maps the actor's Discord roles to `events.create`, so widening flash
 * launching to specific members is a role change, not a deploy.
 */
export async function execute(
  interaction: ChatInputCommandInteraction,
  _api: ApiClient,
): Promise<void> {
  await interaction.showModal(buildFlashModal({}, interaction.locale));
}

/** Native Discord "Apps → Flash mass" action for promoting an existing message. */
export const messageCommand: BotMessageCommand = {
  data: new ContextMenuCommandBuilder()
    .setName(FLASH_MESSAGE_COMMAND_NAME)
    .setNameLocalizations({ it: "Massa flash" })
    .setType(ApplicationCommandType.Message),
  async execute(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    await interaction.showModal(
      buildFlashModal(
        prefillFromMessage(interaction.targetMessage.content),
        interaction.locale,
      ),
    );
  },
};

interface FlashModalPrefill {
  what?: string;
  when?: string;
  notes?: string;
}

export function buildFlashModal(
  prefill: FlashModalPrefill = {},
  locale?: string | null,
): ModalBuilder {
  const what = prefill.what?.trim().slice(0, 100);
  const when = prefill.when?.trim().slice(0, 12);
  const notes = prefill.notes?.trim().slice(0, 500);
  const whatInput = new TextInputBuilder()
    .setCustomId(FLASH_WHAT_FIELD)
    .setLabel(flashCopy(locale, "what"))
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100)
    .setPlaceholder("Castle dive @ Mercer");
  if (what) whatInput.setValue(what);
  const whenInput = new TextInputBuilder()
    .setCustomId(FLASH_WHEN_FIELD)
    .setLabel(flashCopy(locale, "when"))
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(12)
    .setPlaceholder("30m");
  if (when) whenInput.setValue(when);
  const notesInput = new TextInputBuilder()
    .setCustomId(FLASH_NOTES_FIELD)
    .setLabel(flashCopy(locale, "notes"))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder(flashCopy(locale, "notesPlaceholder"));
  if (notes) notesInput.setValue(notes);

  return new ModalBuilder()
    .setCustomId(FLASH_MODAL_ID)
    .setTitle(flashCopy(locale, "modalTitle"))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(whatInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(whenInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(notesInput),
    );
}

/**
 * Prefills the form without deciding what the source text meant. The author
 * reviews or edits the title, time, and notes before submitting.
 */
export function prefillFromMessage(content: string): FlashModalPrefill {
  const lines = content.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const timePattern =
    /\b(?:\d{1,2}h(?:\d{1,2}m)?|\d{1,3}m|(?:[01]?\d|2[0-3])[:.]?[0-5]\d)\b/i;
  const match = timePattern.exec(content);
  const title = match
    ? firstLine
        .replace(match[0], "")
        .replace(/\b(?:in|at|tra|alle|a)\s*$/i, "")
        .replace(/[\s,;:–-]+$/, "")
        .trim()
    : firstLine;
  const notes = [
    match && lines.length === 1
      ? firstLine.slice((match.index ?? 0) + match[0].length).trim()
      : "",
    lines.slice(1).join("\n").trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    what: title || firstLine,
    when: match?.[0] ?? "",
    notes,
  };
}
