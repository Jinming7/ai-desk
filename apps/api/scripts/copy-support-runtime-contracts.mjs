import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
const sourceDir = path.join(repoRoot, "docs", "agents", "support-runtime");
const destinationDir = path.join(apiRoot, "dist", "docs", "agents", "support-runtime");
const destinationRoot = path.join(apiRoot, "dist");

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Support runtime contracts not found: ${sourceDir}`);
}

fs.rmSync(destinationDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
fs.cpSync(sourceDir, destinationDir, { recursive: true });

const registryPath = path.join(sourceDir, "registry.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const contractPaths = Object.values(registry?.contracts ?? {}).filter((item) => typeof item === "string");

for (const relativeContractPath of contractPaths) {
  const normalizedRelative = String(relativeContractPath).replace(/^\/+/, "");
  const sourceContractPath = path.join(repoRoot, normalizedRelative);
  if (!fs.existsSync(sourceContractPath)) {
    throw new Error(`Support contract file not found: ${sourceContractPath}`);
  }
  const destinationContractPath = path.join(destinationRoot, normalizedRelative);
  fs.mkdirSync(path.dirname(destinationContractPath), { recursive: true });
  fs.copyFileSync(sourceContractPath, destinationContractPath);
}

console.log(`[support-contracts] copied ${sourceDir} -> ${destinationDir} and ${contractPaths.length} contract files`);
