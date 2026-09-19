import { composePropertyKnowledgeSnapshot } from "../property-knowledge.service.js";
import type { BenchmarkScenario, MockToolName } from "./contracts.js";
import type { MockToolExecutor } from "./model-evaluation-runner.js";
import {
  FixtureMockToolExecutor,
  type MockToolFixture,
} from "./mock-tool-executor.js";

export class PropertyKnowledgeBenchmarkToolExecutor implements MockToolExecutor {
  private readonly fallback: FixtureMockToolExecutor;

  constructor(
    private readonly propertyRecord: Readonly<Record<string, unknown>>,
    fixtures: Readonly<Partial<Record<MockToolName, MockToolFixture>>> = {},
    private readonly language: "en" | "es" = "en",
  ) {
    this.fallback = new FixtureMockToolExecutor(fixtures);
  }

  async execute(
    tool: MockToolName,
    args: Readonly<Record<string, unknown>>,
    scenario: BenchmarkScenario,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (tool !== "get_property_knowledge") {
      return this.fallback.execute(tool, args, scenario);
    }

    const snapshot = composePropertyKnowledgeSnapshot({
      organizationId: scenario.context.organizationId,
      propertyId: scenario.context.propertyId,
      language: this.language,
      property: this.propertyRecord as any,
    });

    return {
      ...snapshot,
      benchmark: true,
      scenarioId: scenario.id,
      reservationId: scenario.context.reservationId,
    };
  }
}
