// Skills are instructions for one kind of AI task, kept as Markdown files in
// the Agent Skills layout (a folder with a SKILL.md: front matter with `name`
// and `description`, then the instructions). Defaults ship with the app; a
// workspace can override one in .reader/skills/<name>/SKILL.md.
import { deleteAppFile, READER_DIR, readTextFileOpt, writeTextFile } from "./backend";
import { parseFrontMatter, str } from "./frontmatter";

import summarizeBook from "../skills/summarize-book/SKILL.md?raw";
import summarizeSection from "../skills/summarize-section/SKILL.md?raw";
import summarizeSource from "../skills/summarize-source/SKILL.md?raw";

export type SkillName = "summarize-source" | "summarize-section" | "summarize-book";

const BUILT_IN: Record<SkillName, string> = {
  "summarize-source": summarizeSource,
  "summarize-section": summarizeSection,
  "summarize-book": summarizeBook,
};

export interface Skill {
  name: string;
  description: string;
  /** The instructions (the file without its front matter). */
  instructions: string;
  /** The whole SKILL.md text. */
  text: string;
  /** "workspace" when this workspace overrides the built-in skill. */
  origin: "workspace" | "built-in";
}

export const skillOverridePath = (name: SkillName) => `${READER_DIR}/skills/${name}/SKILL.md`;

export function parseSkill(text: string, fallbackName: string, origin: Skill["origin"]): Skill {
  const { front, body } = parseFrontMatter(text);
  return {
    name: str(front.name, fallbackName),
    description: str(front.description),
    instructions: body.trim(),
    text,
    origin,
  };
}

export const builtInSkill = (name: SkillName): Skill => parseSkill(BUILT_IN[name], name, "built-in");

/** The workspace's version of a skill if it has one, else the built-in one. */
export async function loadSkill(name: SkillName): Promise<Skill> {
  const custom = await readTextFileOpt(skillOverridePath(name)).catch(() => null);
  return custom?.trim() ? parseSkill(custom, name, "workspace") : builtInSkill(name);
}

export const saveSkillOverride = (name: SkillName, text: string) => writeTextFile(skillOverridePath(name), text);

/** Go back to the built-in skill. */
export async function resetSkill(name: SkillName) {
  if ((await readTextFileOpt(skillOverridePath(name))) !== null) await deleteAppFile(skillOverridePath(name));
}
