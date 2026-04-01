import type { RepoRegistration } from "./types.js";

function trimSlashes(input: string): string {
  return input.replace(/^\/+|\/+$/g, "");
}

function dropDocExtension(path: string): string {
  return path
    .replace(/\.api\.mdx$/i, "")
    .replace(/\.mdx$/i, "")
    .replace(/\.md$/i, "");
}

function removeIndexSegment(path: string): string {
  return path.replace(/\/index$/i, "");
}

function replaceLastSegment(path: string, value: string): string {
  const normalizedPath = trimSlashes(path);
  const normalizedValue = trimSlashes(dropDocExtension(value));
  if (!normalizedValue) return normalizedPath;
  if (!normalizedPath) return normalizedValue;
  const segments = normalizedPath.split("/").filter(Boolean);
  segments[segments.length - 1] = normalizedValue;
  return segments.join("/");
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FBF]/.test(text);
}

function parseFrontmatter(content: string): Record<string, string> {
  const matched = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!matched?.[1]) return {};
  const lines = matched[1].split(/\r?\n/);
  const data: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim();
    if (/^[>|]-?$/.test(value)) {
      const folded: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const nextRaw = lines[cursor];
        if (!/^\s+/.test(nextRaw)) break;
        const next = nextRaw.trim();
        if (next) folded.push(next);
        cursor += 1;
      }
      if (folded.length) {
        data[key] = folded.join(" ").replace(/^['"]|['"]$/g, "");
      }
      index = cursor - 1;
      continue;
    }
    data[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return data;
}

function buildCandidatePath(path: string, content: string): string | null {
  const frontmatter = parseFrontmatter(content);
  const slug = frontmatter.slug || frontmatter.slug_en || frontmatter.url;
  if (slug) {
    if (!(slug.startsWith("/") || /^https?:\/\//i.test(slug))) {
      return null;
    }
    return slug.startsWith("/") ? slug : `/${slug}`;
  }

  const stripped = removeIndexSegment(dropDocExtension(path));
  const routePath = frontmatter.id ? replaceLastSegment(stripped, frontmatter.id) : stripped;
  if (path.startsWith("open-docs/docs/openapi/")) {
    return `/developer/${trimSlashes(routePath.replace(/^open-docs\/docs\//, ""))}`;
  }
  if (path.startsWith("open-docs/docs/")) {
    return `/developer/${trimSlashes(routePath.replace(/^open-docs\/docs\//, ""))}`;
  }
  if (path.startsWith("docs/")) {
    return `/${trimSlashes(routePath.replace(/^docs\//, ""))}`;
  }
  if (path.startsWith("deploy-docs/")) {
    const localePrefix = containsCjk(content) || !content.trim() ? "/zh-Hans" : "";
    return `${localePrefix}/deploy/${trimSlashes(routePath.replace(/^deploy-docs\//, ""))}`;
  }
  if (path.startsWith("i18n/zh-Hans/")) {
    return `/zh-Hans/${trimSlashes(routePath.replace(/^i18n\/zh-Hans\//, ""))}`;
  }
  if (path.startsWith("i18n/en/")) {
    return `/${trimSlashes(routePath.replace(/^i18n\/en\//, ""))}`;
  }
  return null;
}

export function buildPublicSourceUrl(registration: RepoRegistration, path: string, content: string): string | null {
  if (!registration.public_base_url) return null;
  const candidatePath = buildCandidatePath(path, content);
  if (!candidatePath) return null;

  try {
    const base = registration.public_base_url.endsWith("/") ? registration.public_base_url : `${registration.public_base_url}/`;
    const url = new URL(candidatePath.replace(/^\/+/, ""), base);
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
