import assert from "node:assert/strict";
import test from "node:test";
import { customerRoutePaths, internalRoutePaths } from "../src/app/route-map";

test("customer route map excludes internal portal paths", () => {
  assert.equal(customerRoutePaths.some((p) => p.startsWith("/agent")), false);
});

test("internal route map is isolated from customer routes", () => {
  assert.deepEqual(internalRoutePaths, ["/agent", "/agent/tickets/:id"]);
  assert.equal(internalRoutePaths.some((p) => p === "/" || p.startsWith("/requests") || p.startsWith("/tickets")), false);
});
