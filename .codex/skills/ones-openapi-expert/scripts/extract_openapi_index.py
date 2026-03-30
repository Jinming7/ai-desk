#!/usr/bin/env python3
"""Extract endpoint index from ONES OpenAPI yaml into markdown.

Usage:
  python extract_openapi_index.py /path/to/openapi.yaml > endpoint-index.md
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"PyYAML is required: {exc}")

HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"]


def detect_body_types(op: dict) -> str:
    req = (op or {}).get("requestBody", {})
    content = req.get("content", {}) if isinstance(req, dict) else {}
    return ", ".join(content.keys()) if content else "-"


def detect_response_types(op: dict) -> str:
    responses = (op or {}).get("responses", {})
    seen: list[str] = []
    for _, val in responses.items():
        if not isinstance(val, dict):
            continue
        content = val.get("content", {})
        if not isinstance(content, dict):
            continue
        for ct in content.keys():
            if ct not in seen:
                seen.append(ct)
    return ", ".join(seen) if seen else "-"


def detect_pagination(op: dict) -> str:
    params = (op or {}).get("parameters", [])
    if not isinstance(params, list):
        return "-"
    names = {p.get("name") for p in params if isinstance(p, dict)}
    if "limit" in names and "cursor" in names:
        return "cursor"
    return "-"


def detect_scopes(op: dict) -> str:
    security = (op or {}).get("security", [])
    scopes: list[str] = []
    if isinstance(security, list):
        for item in security:
            if not isinstance(item, dict):
                continue
            oauth2_scopes = item.get("oauth2")
            if isinstance(oauth2_scopes, list):
                for s in oauth2_scopes:
                    if s not in scopes:
                        scopes.append(s)
    return ", ".join(scopes) if scopes else "-"


def detect_deprecated(op: dict) -> str:
    if op.get("deprecated") is True:
        return "yes"
    desc = (op.get("description") or "").lower()
    return "yes" if "deprecated" in desc else "no"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("openapi", help="Path to openapi yaml")
    args = parser.parse_args()

    path = Path(args.openapi)
    if not path.exists():
        print(f"OpenAPI file not found: {path}", file=sys.stderr)
        return 1

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    paths = data.get("paths", {}) if isinstance(data, dict) else {}

    print("# ONES OpenAPI Endpoint Index")
    print()
    print("| Tag | Method | Path | Scopes | Body | Responses | Paging | Deprecated |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")

    for p, item in sorted(paths.items()):
        if not isinstance(item, dict):
            continue
        for method in HTTP_METHODS:
            if method not in item:
                continue
            op = item[method]
            if not isinstance(op, dict):
                continue
            tags = op.get("tags") or ["-"]
            tag = tags[0] if isinstance(tags, list) and tags else "-"
            scopes = detect_scopes(op)
            body = detect_body_types(op)
            responses = detect_response_types(op)
            paging = detect_pagination(op)
            deprecated = detect_deprecated(op)
            print(
                f"| {tag} | {method.upper()} | `{p}` | {scopes} | {body} | {responses} | {paging} | {deprecated} |"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
