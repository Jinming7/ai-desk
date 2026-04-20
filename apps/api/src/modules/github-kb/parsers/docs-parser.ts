import { parseMarkdownSections } from "../markdown.js";
import { collapseWhitespace, uniqueStrings } from "../knowledge-common.js";
import type { ParsedSection } from "../types.js";

export interface ParsedDocPage {
  sections: ParsedSection[];
  docKind: string;
  productArea: string;
  deploymentModel: string;
  aliases: string[];
}

function inferDocKind(path: string, title: string, content: string): string {
  const lower = `${path}\n${title}\n${content}`.toLowerCase();
  if (/troubleshoot|故障|报错|排查/.test(lower)) return "troubleshooting";
  if (/deploy|deployment|runbook|operator|运维|发布/.test(lower)) return "deployment_runbook";
  if (/openapi|api|endpoint|scope|oauth/.test(lower)) return "openapi/api";
  if (/guide|步骤|setup|configure|安装|创建|配置/.test(lower)) return "product_guide";
  if (/limitation|约束|限制|not supported|unsupported/.test(lower)) return "rules";
  return "general";
}

function inferProductArea(path: string, content: string): string {
  const lower = `${path}\n${content}`.toLowerCase();
  if (/openapi|oauth|scope|token|callback|webhook/.test(lower)) return "openapi";
  if (/deploy|deployment|cluster|helm|kubernetes|私有部署/.test(lower)) return "deployment";
  if (/issue|project|field|comment|wiki|space|page/.test(lower)) return "project_management";
  if (/plugin|extension|marketplace/.test(lower)) return "integration";
  return "general";
}

function inferDeploymentModel(content: string): string {
  const lower = content.toLowerCase();
  if (/self-hosted|private deployment|私有部署|本地部署|on-prem/.test(lower)) return "private_deployment";
  if (/saas|public cloud|公有云/.test(lower)) return "public_cloud";
  return "shared";
}

export function parseDocPage(path: string, title: string, content: string): ParsedDocPage {
  const sections = parseMarkdownSections(content);
  const aliases = uniqueStrings([
    title,
    ...sections.slice(0, 8).map((section) => section.title),
    ...[...content.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "")
  ]);
  return {
    sections,
    docKind: inferDocKind(path, title, content),
    productArea: inferProductArea(path, content),
    deploymentModel: inferDeploymentModel(content),
    aliases: aliases.map((item) => collapseWhitespace(item))
  };
}
