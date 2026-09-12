export const PLANS = {
  starter: { name: 'Starter', usd: 149, builds: 5, images: 200, products: 5 },
  growth: { name: 'Growth', usd: 499, builds: 20, images: 800, products: 20 },
  agency: { name: 'Agency', usd: 1499, builds: 75, images: 3000, products: 75 },
} as const;
export type Plan = keyof typeof PLANS;
export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && Object.hasOwn(PLANS, value);
}
export const VIDEO_PACK = { usd: 59, videos: 10 };
