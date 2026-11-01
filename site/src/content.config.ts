import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';

/**
 * The documentation lives in the repository's top-level `docs/` folder, so it
 * reads the same on GitHub and here. Every page is served under `/docs/`.
 */
export const collections = {
  docs: defineCollection({
    loader: glob({
      base: '../docs',
      pattern: ['**/*.md', '!PLAN.md', '!superpowers/**'],
      generateId: ({ entry }) =>
        `docs/${entry.replace(/\.md$/, '').toLowerCase()}`.replace(/\/index$/, ''),
    }),
    schema: docsSchema(),
  }),
};
