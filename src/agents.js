import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function frontmatterField(text, field) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return null;
  const line = block[1].split(/\r?\n/).find((l) => l.startsWith(`${field}:`));
  if (!line) return null;
  return line.slice(field.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2') || null;
}

/**
 * Lists the Claude Code agent definitions (`*.md`) in `dir`, sorted by name.
 * The name comes from the frontmatter `name`, falling back to the file name.
 * A missing or unreadable directory gives an empty list.
 */
export function listAgents(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const agents = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    agents.push({
      name: frontmatterField(text, 'name') ?? basename(file, '.md'),
      description: frontmatterField(text, 'description') ?? '',
    });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
