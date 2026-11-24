// [[wiki links]], as in Obsidian: [[target]], [[target|label]] and
// [[target#page=3|p. 3]]. Targets are workspace paths; a bare name with no
// folder and no extension is a concept page in wiki/concepts/.
import { CONCEPTS_DIR } from "./summary";
import { outsideCode } from "./math";

export const WIKILINK_SCHEME = "wikilink:";

const WIKILINK = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g;

/** Turn wiki links into Markdown links with a `wikilink:` URL (code is left alone). */
export function linkifyWikiLinks(markdown: string): string {
  return outsideCode(markdown, (text) =>
    text.replace(WIKILINK, (_, target: string, label?: string) => {
      const shown = (label ?? defaultLabel(target)).replace(/[[\]]/g, "");
      return `[${shown}](${WIKILINK_SCHEME}${encodeURIComponent(target.trim())})`;
    }),
  );
}

function defaultLabel(target: string): string {
  const { path, page } = resolveWikiLink(target);
  const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  return page ? `${name}, p. ${page}` : target.includes("/") ? name : target.trim();
}

/** Where a link points: a workspace file, and a page for PDF citations. */
export function resolveWikiLink(target: string): { path: string; page?: number } {
  const [rawPath, fragment = ""] = target.trim().split("#", 2);
  const name = rawPath.trim();
  const page = Number(fragment.match(/^page=(\d+)/)?.[1]) || undefined;
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(name);
  const path = hasExt ? name : name.includes("/") ? `${name}.md` : `${CONCEPTS_DIR}/${name}.md`;
  return page ? { path, page } : { path };
}
