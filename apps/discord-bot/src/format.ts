/** Formats silver amounts consistently for Discord messages. */
export function formatSilver(value: number | string | null | undefined): string {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toLocaleString('it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
