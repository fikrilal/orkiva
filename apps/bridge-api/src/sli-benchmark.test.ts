import { describe, expect, it } from "vitest";

import { MVP_SLI_THRESHOLDS, runInMemorySliBenchmark } from "./sli-benchmark.js";

describe("phase Y SLI benchmark", () => {
  it("meets MVP SLO targets in pilot harness", async () => {
    const report = await runInMemorySliBenchmark({
      iterations: 40
    });

    expect(report.post.attempts).toBe(40);
    expect(report.read.attempts).toBe(40);
    expect(report.trigger.attempts).toBe(40);
    expect(report.post.successRate).toBeGreaterThanOrEqual(MVP_SLI_THRESHOLDS.postSuccessRate);
    expect(report.read.successRate).toBeGreaterThanOrEqual(MVP_SLI_THRESHOLDS.readSuccessRate);
    expect(report.postToVisibleP95Ms).toBeLessThanOrEqual(MVP_SLI_THRESHOLDS.postToVisibleP95Ms);
    expect(report.messageToWakeTriggerP95Ms).toBeLessThanOrEqual(
      MVP_SLI_THRESHOLDS.messageToWakeTriggerP95Ms
    );
  });
});
