/** Formats silver amounts consistently for Discord messages. */
export function formatSilver(value: number | string | null | undefined): string {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
