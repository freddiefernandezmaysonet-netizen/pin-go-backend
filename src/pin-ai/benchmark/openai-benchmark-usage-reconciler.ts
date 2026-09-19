export type ProviderUsageStatus =
  | "RECORDED"
  | "UNAVAILABLE"
  | "DISABLED"
  | "MISSING_ADMIN_KEY"
  | "MISSING_SCOPE_FILTER";

export type ProviderUsageSummary = Readonly<{
  status: ProviderUsageStatus;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelRequests: number;
  startTimeUnix: number;
  endTimeUnix: number;
  model?: string;
  projectId?: string;
  apiKeyId?: string;
}>;

export type OpenAIUsageReconcilerConfig = Readonly<{
  enabled: boolean;
  adminKey?: string;
  baseUrl?: string;
}>;

export type OpenAIUsageFetch = (
  input: string,
  init: Readonly<{
    method: "GET";
    headers: Readonly<Record<string, string>>;
  }>,
) => Promise<Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>>;

export type OpenAIUsageReconcileRequest = Readonly<{
  startTimeUnix: number;
  endTimeUnix: number;
  model?: string;
  projectId?: string;
  apiKeyId?: string;
}>;

export class OpenAIUsageReconciler {
  constructor(
    private readonly config: OpenAIUsageReconcilerConfig,
    private readonly fetchImpl: OpenAIUsageFetch,
  ) {}

  async reconcile(request: OpenAIUsageReconcileRequest): Promise<ProviderUsageSummary> {
    if (!this.config.enabled) {
      return emptySummary("DISABLED", request);
    }

    if (!this.config.adminKey) {
      return emptySummary("MISSING_ADMIN_KEY", request);
    }

    if (!request.projectId && !request.apiKeyId) {
      return emptySummary("MISSING_SCOPE_FILTER", request);
    }

    const query = new URLSearchParams({
      start_time: String(request.startTimeUnix),
      end_time: String(request.endTimeUnix),
      bucket_width: "1m",
      "group_by[]": "model",
    });

    if (request.model) query.append("models[]", request.model);
    if (request.projectId) query.append("project_ids[]", request.projectId);
    if (request.apiKeyId) query.append("api_key_ids[]", request.apiKeyId);

    const baseUrl = this.config.baseUrl ?? "https://api.openai.com";
    const response = await this.fetchImpl(
      `${baseUrl}/v1/organization/usage/completions?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.adminKey}`,
          "content-type": "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`PIN_AI_BENCHMARK_USAGE_HTTP_${response.status}`);
    }

    const payload = await response.json();
    const totals = aggregateUsage(payload);

    return {
      status:
        totals.inputTokens > 0 ||
        totals.cachedInputTokens > 0 ||
        totals.outputTokens > 0 ||
        totals.modelRequests > 0
          ? "RECORDED"
          : "UNAVAILABLE",
      ...totals,
      startTimeUnix: request.startTimeUnix,
      endTimeUnix: request.endTimeUnix,
      ...(request.model ? { model: request.model } : {}),
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.apiKeyId ? { apiKeyId: request.apiKeyId } : {}),
    };
  }
}

function aggregateUsage(payload: unknown) {
  const root = asRecord(payload);
  const buckets = Array.isArray(root.data) ? root.data : [];

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let modelRequests = 0;

  for (const bucketValue of buckets) {
    const bucket = asRecord(bucketValue);
    const results = Array.isArray(bucket.results) ? bucket.results : [];

    for (const resultValue of results) {
      const result = asRecord(resultValue);
      inputTokens += nonNegativeNumber(result.input_tokens);
      cachedInputTokens += nonNegativeNumber(result.input_cached_tokens);
      outputTokens += nonNegativeNumber(result.output_tokens);
      modelRequests += nonNegativeNumber(result.num_model_requests);
    }
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    modelRequests,
  };
}

function emptySummary(
  status: Exclude<ProviderUsageStatus, "RECORDED" | "UNAVAILABLE">,
  request: OpenAIUsageReconcileRequest,
): ProviderUsageSummary {
  return {
    status,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelRequests: 0,
    startTimeUnix: request.startTimeUnix,
    endTimeUnix: request.endTimeUnix,
    ...(request.model ? { model: request.model } : {}),
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.apiKeyId ? { apiKeyId: request.apiKeyId } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
