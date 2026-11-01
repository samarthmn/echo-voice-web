import GithubSlugger from 'github-slugger';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Docs are written for GitHub, with links like `install.md#updating` or
 * `../scripts/setup.sh`. On the site those become `/docs/install/#updating`
 * and a GitHub link respectively. Absolute URLs and in-page anchors are kept.
 *
 * Every rewritten link is also checked: the target doc or repository file must
 * exist, and a `#heading` must match a heading in the target doc. A broken link
 * fails the build.
 */
const GITHUB_BLOB = 'https://github.com/samarthmn/echo-voice-web/blob/main/';

interface Node {
  type: string;
  url?: unknown;
  children?: Node[];
}

const anchorCache = new Map<string, Set<string>>();

/** Heading anchors of a Markdown file, slugged the way GitHub and Starlight do. */
function anchors(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const slugger = new GithubSlugger();
  const found = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1]) continue;
    const text = heading[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '');
    found.add(slugger.slug(text));
  }
  anchorCache.set(file, found);
  return found;
}

function rewriteRepoLink(
  url: string,
  fromFile: string,
  docsDir: string,
  repoRoot: string,
): { url: string; error?: string } {
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return { url };
  const hashIndex = url.indexOf('#');
  const target = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  if (!target) return { url };
  const resolved = path.resolve(path.dirname(fromFile), decodeURI(target));
  if (!existsSync(resolved)) return { url, error: `${url}: ${target} does not exist` };
  const inDocs = path.relative(docsDir, resolved);
  if (!inDocs.startsWith('..') && !path.isAbsolute(inDocs) && resolved.endsWith('.md')) {
    if (hash && !anchors(resolved).has(hash.slice(1)))
      return { url, error: `${url}: no heading ${hash} in ${target}` };
    const slug = inDocs
      .slice(0, -3)
      .split(path.sep)
      .join('/')
      .toLowerCase()
      .replace(/(?:^|\/)index$/, '');
    return { url: `/docs/${slug ? `${slug}/` : ''}${hash}` };
  }
  const inRepo = path.relative(repoRoot, resolved);
  if (!inRepo.startsWith('..') && !path.isAbsolute(inRepo))
    return { url: `${GITHUB_BLOB}${inRepo.split(path.sep).join('/')}${hash}` };
  return { url, error: `${url}: points outside the repository` };
}

export function remarkRepoLinks({ docsDir, repoRoot }: { docsDir: string; repoRoot: string }) {
  return (tree: Node, file: { path?: string }) => {
    const from = file.path;
    if (!from || path.relative(docsDir, from).startsWith('..')) return;
    const errors: string[] = [];
    const walk = (node: Node) => {
      if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
        const result = rewriteRepoLink(node.url, from, docsDir, repoRoot);
        node.url = result.url;
        if (result.error) errors.push(result.error);
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    if (errors.length)
      throw new Error(
        `Broken links in ${path.relative(repoRoot, from)}:\n  ${errors.join('\n  ')}`,
      );
  };
}
