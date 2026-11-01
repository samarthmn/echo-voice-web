import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import type { AstroIntegration } from 'astro';
import { defineConfig } from 'astro/config';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FONT_FILES, writeTokens } from '../scripts/build-tokens.ts';
import { CLOUDFLARE_ANALYTICS_TOKEN } from './src/analytics.ts';
import { remarkRepoLinks } from './src/plugins/remark-repo-links.ts';
import { sidebar } from './src/sidebar.ts';

const site = 'https://echo-web.samarthmn.com';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const docsDir = fileURLToPath(new URL('../docs', import.meta.url));
const github = 'https://github.com/samarthmn/echo-voice-web';
const ogImage = `${site}/og-image.png`;
const analytics = CLOUDFLARE_ANALYTICS_TOKEN
  ? [
      {
        tag: 'script' as const,
        attrs: {
          defer: true,
          src: 'https://static.cloudflareinsights.com/beacon.min.js',
          'data-cf-beacon': JSON.stringify({ token: CLOUDFLARE_ANALYTICS_TOKEN }),
        },
      },
    ]
  : [];

/** Generate the Organic tokens and copy the self-hosted fonts and brand files into the site. */
function organicTokens(): AstroIntegration {
  return {
    name: 'echo-organic-tokens',
    hooks: {
      'astro:config:setup': async () => {
        await writeTokens(
          fileURLToPath(new URL('./src/styles/tokens.generated.css', import.meta.url)),
          '/fonts/',
        );
        const fonts = new URL('./public/fonts/', import.meta.url);
        await mkdir(fonts, { recursive: true });
        for (const name of [...FONT_FILES, 'OFL-Mulish.txt'])
          await copyFile(new URL(`../public/fonts/${name}`, import.meta.url), new URL(name, fonts));
        for (const [from, to] of [
          ['../brand/logo.svg', 'favicon.svg'],
          ['../brand/favicon.ico', 'favicon.ico'],
          ['../brand/png/apple-touch-icon.png', 'apple-touch-icon.png'],
          ['../brand/social/og-image.png', 'og-image.png'],
        ] as const)
          await copyFile(
            new URL(from, import.meta.url),
            new URL(`./public/${to}`, import.meta.url),
          );
      },
    },
  };
}

export default defineConfig({
  site,
  trailingSlash: 'always',
  markdown: { processor: unified({ remarkPlugins: [[remarkRepoLinks, { docsDir, repoRoot }]] }) },
  integrations: [
    organicTokens(),
    starlight({
      title: 'Echo',
      description:
        'Open-source, self-hosted meeting recorder, transcriber and note-taker that runs entirely on your Mac.',
      logo: { src: '../brand/logo.svg', alt: 'Echo' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: github }],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImage } },
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '48x48' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        ...analytics,
      ],
      customCss: ['./src/styles/tokens.generated.css', './src/styles/starlight.css'],
      sidebar,
      lastUpdated: false,
      pagination: true,
    }),
    sitemap(),
  ],
});
