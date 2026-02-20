import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "./index.js";

describe("MetricsRegistry", () => {
  it("renders prometheus counters with labels", () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter("bridge_requests_total", {
      help: "Bridge request count",
      labels: {
        method: "POST",
        status: "200"
      }
    });
    registry.incrementCounter("bridge_requests_total", {
      help: "Bridge request count",
      labels: {
        method: "POST",
        status: "200"
      }
    });

    const output = registry.renderPrometheus();
    expect(output).toContain("# HELP bridge_requests_total Bridge request count");
    expect(output).toContain("# TYPE bridge_requests_total counter");
    expect(output).toContain('bridge_requests_total{method="POST",status="200"} 2');
  });
});
