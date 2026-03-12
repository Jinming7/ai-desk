import type { ParsedSection } from "./types.js";

interface HeadingState {
  level: number;
  text: string;
}

function normalizeLine(line: string): string {
  return line.replace(/\t/g, "  ").replace(/\s+$/g, "");
}

function extractHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

export function parseMarkdownSections(input: string): ParsedSection[] {
  const lines = input.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let headingStack: HeadingState[] = [];
  let currentBuffer: string[] = [];
  let order = 0;
  let inCodeFence = false;

  const flush = () => {
    const content = currentBuffer.join("\n").trim();
    if (!content && sections.length > 0) {
      currentBuffer = [];
      return;
    }
    const headingPath = headingStack.map((item) => item.text).join(" > ") || "ROOT";
    const title = headingStack.length ? headingStack[headingStack.length - 1].text : "ROOT";
    sections.push({
      headingPath,
      title,
      content: content || "",
      order
    });
    order += 1;
    currentBuffer = [];
  };

  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      currentBuffer.push(line);
      continue;
    }

    if (!inCodeFence) {
      const heading = extractHeading(line);
      if (heading) {
        if (currentBuffer.length || sections.length === 0) {
          flush();
        }
        headingStack = headingStack.filter((h) => h.level < heading.level);
        headingStack.push({ level: heading.level, text: heading.text });
        continue;
      }
    }

    currentBuffer.push(line);
  }

  if (currentBuffer.length || sections.length === 0) {
    flush();
  }

  return sections.filter((section) => section.content.length > 0 || section.headingPath !== "ROOT");
}
