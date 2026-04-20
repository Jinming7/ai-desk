import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupportCaseFrame } from "./types.js";
import {
  buildSupportEvidencePolicy,
  filterSupportEvidenceByPolicy,
  getSupportEvidenceProfile,
  matchesSupportEvidencePolicy
} from "./support-evidence-policy.js";

function createDeploymentCapabilityCaseFrame(): SupportCaseFrame {
  return {
    goal: "confirm supported linux distributions",
    symptom: "confirm supported linux distributions",
    object: "linux distributions",
    action_type: "capability_confirmation",
    deployment_model: "private_deployment",
    product_area: "deployment",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["supported operating systems", "deployment requirements"],
    required_doc_kinds: ["deployment_runbook", "product_guide", "rules"],
    question_type: "capability_confirmation",
    primary_domain: "deployment"
  };
}

function createOpenApiCapabilityCaseFrame(): SupportCaseFrame {
  return {
    goal: "confirm ONESQL clause support",
    symptom: "confirm ONESQL clause support",
    object: "ONESQL query syntax",
    action_type: "capability_confirmation",
    deployment_model: "shared",
    product_area: "openapi",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["ORDER BY GROUP BY ONESQL"],
    required_doc_kinds: ["openapi/api", "product_guide"],
    question_type: "capability_confirmation",
    primary_domain: "openapi"
  };
}

function createPrivateDeploymentIntegrationCaseFrame(): SupportCaseFrame {
  return {
    goal: "confirm Azure AD availability in private deployment",
    symptom: "confirm Azure AD availability in private deployment",
    object: "Azure AD integration",
    action_type: "capability_confirmation",
    deployment_model: "private_deployment",
    product_area: "integrations",
    constraints: [],
    missing_critical_info: [],
    retrieval_queries: ["Azure AD integration ONES.com Cloud private deployment"],
    required_doc_kinds: ["product_guide", "rules"],
    question_type: "capability_confirmation",
    primary_domain: "integrations"
  };
}

test("buildSupportEvidencePolicy marks deployment capability questions as strict", () => {
  const policy = buildSupportEvidencePolicy(createDeploymentCapabilityCaseFrame());

  assert.equal(policy?.strict, true);
  assert.deepEqual(policy?.allowedProductAreas, ["deployment"]);
  assert.deepEqual(policy?.allowedDeploymentModels, ["private_deployment"]);
});

test("matchesSupportEvidencePolicy rejects generic shared requirements for strict deployment capability cases", () => {
  const caseFrame = createDeploymentCapabilityCaseFrame();

  assert.equal(
    matchesSupportEvidencePolicy(
      {
        supportMetadata: {
          product_area: "general",
          deployment_model: "shared",
          evidence_kind: "capability",
          doc_kind: "deployment_runbook"
        }
      },
      caseFrame
    ),
    false
  );
});

test("filterSupportEvidenceByPolicy drops off-policy evidence instead of falling back to all results in strict mode", () => {
  const caseFrame = createDeploymentCapabilityCaseFrame();
  const evidence = [
    {
      id: "generic",
      supportMetadata: {
        product_area: "general",
        deployment_model: "shared",
        evidence_kind: "capability",
        doc_kind: "deployment_runbook"
      }
    }
  ];

  const filtered = filterSupportEvidenceByPolicy(evidence, caseFrame, (item) => item);

  assert.deepEqual(filtered, []);
});

test("matchesSupportEvidencePolicy accepts deployment-private evidence for strict deployment capability cases", () => {
  const caseFrame = createDeploymentCapabilityCaseFrame();

  assert.equal(
    matchesSupportEvidencePolicy(
      {
        supportMetadata: {
          product_area: "deployment",
          deployment_model: "private_deployment",
          evidence_kind: "capability",
          doc_kind: "product_guide"
        }
      },
      caseFrame
    ),
    true
  );
});

test("matchesSupportEvidencePolicy accepts api_operation evidence for strict OpenAPI capability cases", () => {
  const caseFrame = createOpenApiCapabilityCaseFrame();

  assert.equal(
    matchesSupportEvidencePolicy(
      {
        supportMetadata: {
          product_area: "openapi",
          deployment_model: "shared",
          evidence_kind: "api_operation",
          doc_kind: "openapi/api"
        }
      },
      caseFrame
    ),
    true
  );
});

test("matchesSupportEvidencePolicy accepts integration guidance evidence for private-deployment integration availability cases", () => {
  const caseFrame = createPrivateDeploymentIntegrationCaseFrame();

  assert.equal(
    matchesSupportEvidencePolicy(
      {
        supportMetadata: {
          product_area: "integrations",
          deployment_model: "shared",
          evidence_kind: "integration_guidance",
          doc_kind: "product_guide"
        }
      },
      caseFrame
    ),
    true
  );
});

test("matchesSupportEvidencePolicy does not infer deployment semantics from degraded path-only evidence", () => {
  const caseFrame = createDeploymentCapabilityCaseFrame();

  assert.equal(
    matchesSupportEvidencePolicy(
      {
        path: "deploy-docs/quick-start/requirements.mdx",
        title: "1. 准备服务器",
        headingPath: "3. 操作系统要求",
        snippet: "只支持 Linux 4.* 以上内核的操作系统，支持 64 位 Ubuntu 18/20/24、64 位 Red Hat 8.0 及以上，不再支持 CentOS 7 系列。",
        supportMetadata: {
          product_area: "general",
          deployment_model: "shared",
          evidence_kind: "capability"
        }
      },
      caseFrame
    ),
    false
  );
});

test("getSupportEvidenceProfile preserves explicit evidence metadata instead of reclassifying snippet prose", () => {
  const profile = getSupportEvidenceProfile({
    path: "deploy-docs/data/docker-to-k3s.cn.md",
    title: "Docker迁移K3S方案",
    headingPath: "Docker迁移K3S方案 > 四、迁移实施预演",
    snippet: "迁移前先做好备份、目标服务器检查、实施预演与回滚预案，确认切换窗口和演练步骤。",
    supportMetadata: {
      product_area: "deployment",
      deployment_model: "private_deployment",
      evidence_kind: "capability"
    }
  });

  assert.equal(profile.productArea, "deployment");
  assert.equal(profile.deploymentModel, "private_deployment");
  assert.equal(profile.evidenceKind, "capability");
  assert.equal(profile.docKind, "deployment_runbook");
});
