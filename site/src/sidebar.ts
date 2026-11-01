/** Docs navigation. Each slug is `docs/<file name in the repo's docs/ folder>`. */
export const sidebar = [
  {
    label: 'Getting started',
    items: [
      { label: 'What Echo is', slug: 'docs' },
      'docs/requirements',
      'docs/install',
      'docs/first-recording',
    ],
  },
  {
    label: 'Using Echo',
    items: [
      'docs/extension',
      'docs/recording',
      'docs/transcription-models',
      'docs/speakers',
      'docs/notes-ollama',
      'docs/calendar',
    ],
  },
  {
    label: 'Self-hosting',
    items: [
      'docs/configuration',
      'docs/auto-start',
      'docs/updating',
      'docs/backups-and-recovery',
      'docs/security-model',
      'docs/privacy',
      'docs/troubleshooting',
      'docs/uninstall',
      'docs/faq',
    ],
  },
  {
    label: 'Reference',
    items: ['docs/architecture', 'docs/cli', 'docs/http-api', 'docs/licenses'],
  },
  {
    label: 'Contributing',
    items: ['docs/development', 'docs/releasing', 'docs/store-listing'],
  },
];
