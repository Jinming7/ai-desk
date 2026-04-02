function escapeRegexChar(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegex(glob: string): RegExp {
  let pattern = "";

  for (let index = 0; index < glob.length; index += 1) {
    const current = glob[index];
    if (current === "*") {
      const next = glob[index + 1];
      const afterNext = glob[index + 2];
      if (next === "*") {
        if (afterNext === "/") {
          pattern += "(?:.*/)?";
          index += 2;
          continue;
        }
        pattern += ".*";
        index += 1;
        continue;
      }
      pattern += "[^/]*";
      continue;
    }

    pattern += escapeRegexChar(current);
  }

  return new RegExp(`^${pattern}$`, "i");
}

export function isPathIncluded(path: string, includePaths: string[], excludePaths: string[]): boolean {
  const includeRegex = includePaths.map(globToRegex);
  const excludeRegex = excludePaths.map(globToRegex);
  const included = includeRegex.some((regex) => regex.test(path));
  const excluded = excludeRegex.some((regex) => regex.test(path));
  return included && !excluded;
}
