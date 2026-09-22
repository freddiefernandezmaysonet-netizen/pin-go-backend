import type { BenchmarkScenario, MockToolName } from "./contracts.js";
import type { MockToolExecutor } from "./model-evaluation-runner.js";

export type MockToolFixture = Readonly<Record<string, unknown>>;

export class FixtureMockToolExecutor implements MockToolExecutor {
  constructor(
    private readonly fixtures: Readonly<Partial<Record<MockToolName, MockToolFixture>>>,
  ) {}

  async execute(
    tool: MockToolName,
    _args: Readonly<Record<string, unknown>>,
    scenario: BenchmarkScenario,
  ): Promise<Readonly<Record<string, unknown>>> {
    const fixture = this.fixtures[tool];

    if (!fixture) {
      throw new Error(`MOCK_TOOL_FIXTURE_MISSING:${scenario.id}:${tool}`);
    }

    return {
      ...fixture,
      benchmark: true,
      scenarioId: scenario.id,
      organizationId: scenario.context.organizationId,
      propertyId: scenario.context.propertyId,
      reservationId: scenario.context.reservationId,
    };
  }
}
