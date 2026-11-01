export const SITE_URL = 'https://echo-web.samarthmn.com';
export const GITHUB_URL = 'https://github.com/samarthmn/echo-voice-web';
export const TAGLINE = 'Open-source AI meeting notes that never leave your Mac';
export const DESCRIPTION =
  'Echo is an open-source, self-hosted meeting recorder, transcriber and note-taker for macOS. Whisper and Ollama run on your Mac, with no bot in the call and no account. A local alternative to Fireflies, Otter.ai and Fathom.';
export const CHECKED = '1 November 2026';

export interface Competitor {
  name: string;
  slug: 'fireflies' | 'otter' | 'fathom';
  bot: string;
  price: string;
  storage: string;
  sources: { label: string; url: string }[];
}

export const COMPETITORS: Competitor[] = [
  {
    name: 'Fireflies',
    slug: 'fireflies',
    bot: 'Yes, by default; a Chrome extension can record without the bot',
    price: 'Free plan; paid Pro, Business and Enterprise plans',
    storage: 'Fireflies’ cloud',
    sources: [{ label: 'fireflies.ai/pricing', url: 'https://fireflies.ai/pricing' }],
  },
  {
    name: 'Otter.ai',
    slug: 'otter',
    bot: 'Yes; its notetaker joins Zoom, Teams and Google Meet',
    price: 'Free Basic plan; paid Pro, Business and Enterprise plans',
    storage: 'Otter’s cloud',
    sources: [{ label: 'otter.ai/pricing', url: 'https://otter.ai/pricing' }],
  },
  {
    name: 'Fathom',
    slug: 'fathom',
    bot: 'Yes, by default; bot-free capture is in beta on Mac',
    price: 'Free plan; paid Premium, Team and Business plans',
    storage: 'Fathom’s cloud',
    sources: [{ label: 'fathom.ai/pricing', url: 'https://www.fathom.ai/pricing' }],
  },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is Echo really free?',
    a: 'Yes. Echo is open source under the MIT licence. There is no paid tier, no account and no subscription.',
  },
  {
    q: 'Is Echo a service?',
    a: 'No. Echo is software you install and run on your own Mac. Nobody operates it for you, and the project never receives your recordings, transcripts or notes.',
  },
  {
    q: 'Does a bot join my calls?',
    a: 'No. A browser extension records the meeting tab you already have open in Brave or Chrome. Other participants do not see a notetaker, so ask for their consent.',
  },
  {
    q: 'Which meeting apps does it work with?',
    a: 'Google Meet, Zoom (web) and Microsoft Teams (web). You can also record in person with your microphone, or upload an existing audio file.',
  },
  {
    q: 'What do I need to run it?',
    a: 'An Apple Silicon Mac on macOS 14 or later, Brave or Chrome, and about ten minutes in Terminal to build it from source. Ollama is optional, for notes.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes, once you have downloaded the models. Recording, transcription, speaker grouping and notes all run on your Mac.',
  },
  {
    q: 'How is my data protected?',
    a: 'Echo only listens on your Mac’s loopback address. The library is encrypted with SQLCipher, its key lives in the macOS Keychain, and a 24-word recovery phrase lets you restore it.',
  },
];
