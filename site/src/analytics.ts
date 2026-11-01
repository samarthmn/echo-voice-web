/**
 * Vercel Web Analytics for echo-web.samarthmn.com. It is cookieless, loads from
 * the site's own /_vercel/insights path, and is only included in builds that
 * run on Vercel (which sets VERCEL=1). It never loads in the Echo app.
 * Enable it in the Vercel project under Analytics.
 */
export const VERCEL_ANALYTICS = process.env.VERCEL === '1';

/** Inline queue stub from Vercel's documented non-framework snippet. */
export const VERCEL_ANALYTICS_STUB =
  'window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };';
