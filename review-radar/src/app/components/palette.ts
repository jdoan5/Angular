// Stable color per app name — shared by every chart and legend.
const PALETTE = [
  '#4aa3ff', // blue
  '#f5a623', // amber
  '#38c172', // green
  '#ef5753', // red
  '#9561e2', // violet
  '#e8788a', // rose
  '#50d2c2', // teal
];

const assigned = new Map<string, string>();

export function appColor(name: string): string {
  if (!assigned.has(name)) {
    assigned.set(name, PALETTE[assigned.size % PALETTE.length]);
  }
  return assigned.get(name)!;
}
