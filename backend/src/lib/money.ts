// Money is stored as BigInt paise (1 INR = 100 paise). Never use floats for money.
export const RUPEE = 100n;

export const rupeesToPaise = (rupees: number): bigint =>
  BigInt(Math.round(rupees * 100));

export const paiseToRupees = (paise: bigint): number => Number(paise) / 100;

/** Format paise as "₹1,23,456.00" (Indian grouping). */
export function formatPaise(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / RUPEE;
  const fraction = abs % RUPEE;
  const r = rupees.toString();
  // Indian digit grouping: last 3 digits, then groups of 2.
  let grouped: string;
  if (r.length <= 3) {
    grouped = r;
  } else {
    const last3 = r.slice(-3);
    const rest = r.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  const frac = fraction.toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${grouped}.${frac}`;
}

/** GST helper — rate is a percentage (e.g. 5 for 5%). */
export const gstOn = (basePaise: bigint, ratePercent: number): bigint =>
  (basePaise * BigInt(Math.round(ratePercent * 100))) / 10000n;
