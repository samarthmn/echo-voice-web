/**
 * Cloudflare Web Analytics beacon token for echo-web.samarthmn.com, read from
 * the CLOUDFLARE_ANALYTICS_TOKEN build variable (set it in the Cloudflare
 * dashboard). It is cookieless and only ever loads on the website, never in
 * the Echo app. Without the variable the site builds without analytics.
 */
export const CLOUDFLARE_ANALYTICS_TOKEN = process.env.CLOUDFLARE_ANALYTICS_TOKEN ?? '';
