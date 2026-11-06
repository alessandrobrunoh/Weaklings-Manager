/** Discord JSON error: the interaction token expired (the 3 second window passed). */
const UNKNOWN_INTERACTION = 10062;
/** Discord JSON error: the interaction was already acknowledged. */
const ALREADY_ACKNOWLEDGED = 40060;

/** The slice of an interaction that error reporting needs. */
export interface ReplyableInteraction {
  replied: boolean;
  deferred: boolean;
  reply(payload: never): Promise<unknown>;
  followUp(payload: never): Promise<unknown>;
}

function discordCode(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "number" ? code : null;
  }
  return null;
}

/**
 * Sends an error message for an interaction without ever throwing.
 *
 * A slow backend can push a command past Discord's 3 second window, after which
 * `reply` fails with 10062. Reporting that failure from inside the event
 * listener would only raise a second, unhandled rejection. An interaction that
 * was acknowledged in the meantime (40060) is answered with a follow-up instead.
 *
 * @returns true when the message reached Discord.
 *
 * @example
 * ```ts
 * await safeErrorReply(interaction, { embeds: [errEmbed], flags: ["Ephemeral"] });
 * ```
 */
export async function safeErrorReply<P>(
  interaction: ReplyableInteraction,
  payload: P,
): Promise<boolean> {
  const send = async (viaFollowUp: boolean): Promise<void> => {
    if (viaFollowUp) await interaction.followUp(payload as never);
    else await interaction.reply(payload as never);
  };
  try {
    await send(interaction.replied || interaction.deferred);
    return true;
  } catch (error) {
    const code = discordCode(error);
    if (code === ALREADY_ACKNOWLEDGED) {
      try {
        await send(true);
        return true;
      } catch (followUpError) {
        console.warn("[Bot] Could not follow up on an acknowledged interaction:", followUpError);
        return false;
      }
    }
    if (code === UNKNOWN_INTERACTION) {
      console.warn("[Bot] Interaction expired before an error reply could be sent.");
      return false;
    }
    console.warn("[Bot] Could not send an interaction error reply:", error);
    return false;
  }
}
