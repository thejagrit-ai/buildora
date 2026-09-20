// Money arrives from the API as string-encoded paise (BigInt-safe). Format for
// display in ₹ with Indian digit grouping. Never do float math on money.
export function formatPaise(paise: string | number | bigint | null | undefined): string {
  if (paise == null) return '₹0';
  const big = typeof paise === 'bigint' ? paise : BigInt(paise);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const rupees = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  const r = rupees.toString();
  let grouped: string;
  if (r.length <= 3) grouped = r;
  else {
    const last3 = r.slice(-3);
    grouped = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return `${negative ? '-' : ''}₹${grouped}${frac === '00' ? '' : '.' + frac}`;
}

export const rupeesToPaiseNumber = (rupees: number): number => Math.round(rupees * 100);
