import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAIUsageReconciler,
  type OpenAIUsageFetch,
} from "./openai-benchmark-usage-reconciler.js";

test("usage reconciler is default-off and makes no request", async () => {
  let called = false;
  const fetchImpl: OpenAIUsageFetch = async () => {
    called = true;
    throw new Error("unexpected fetch");
  };

  const reconciler = new OpenAIUsageReconciler({ enabled: false }, fetchImpl);
  const result = await reconciler.reconcile({
    startTimeUnix: 100,
    endTimeUnix: 160,
    model: "gpt-5.6-luna",
    apiKeyId: "key_benchmark",
  });

  assert.equal(result.status, "DISABLED");
  assert.equal(called, false);
});

test("usage reconciler requires an admin key", async () => {
  const fetchImpl: OpenAIUsageFetch = async () => {
    throw new Error("unexpected fetch");
  };

  const reconciler = new OpenAIUsageReconciler({ enabled: true }, fetchImpl);
  const result = await reconciler.reconcile({
    startTimeUnix: 100,
    endTimeUnix: 160,
    apiKeyId: "key_benchmark",
  });

  assert.equal(result.status, "MISSING_ADMIN_KEY");
});

test("usage reconciler refuses unscoped organization usage", async () => {
  const fetchImpl: OpenAIUsageFetch = async () => {
    throw new Error("unexpected fetch");
  };

  const reconciler = new OpenAIUsageReconciler(
    { enabled: true, adminKey: "admin-test-key" },
    fetchImpl,
  );

  const result = await reconciler.reconcile({
    startTimeUnix: 100,
    endTimeUnix: 160,
    model: "gpt-5.6-luna",
  });

  assert.equal(result.status, "MISSING_SCOPE_FILTER");
});

test("usage reconciler aggregates provider tokens and model requests", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";

  const fetchImpl: OpenAIUsageFetch = async (url, init) => {
    capturedUrl = url;
    capturedAuthorization = init.headers.authorization;

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          object: "page",
          data: [
            {
              object: "bucket",
              start_time: 100,
              end_time: 160,
              results: [
                {
                  object: "organization.usage.completions.result",
                  input_tokens: 70000,
                  input_cached_tokens: 50000,
                  output_tokens: 7000,
                  num_model_requests: 3,
                  model: "gpt-5.6-luna",
                  api_key_id: "key_benchmark",
                },
              ],
            },
          ],
          has_more: false,
        };
      },
    };
  };

  const reconciler = new OpenAIUsageReconciler(
    {
      enabled: true,
      adminKey: "admin-test-key",
      baseUrl: "https://api.openai.com",
    },
    fetchImpl,
  );

  const result = await reconciler.reconcile({
    startTimeUnix: 100,
    endTimeUnix: 160,
    model: "gpt-5.6-luna",
    apiKeyId: "key_benchmark",
  });

  assert.equal(capturedAuthorization, "Bearer admin-test-key");
  assert.match(capturedUrl, /\/v1\/organization\/usage\/completions\?/);
  assert.match(capturedUrl, /api_key_ids%5B%5D=key_benchmark/);
  assert.match(capturedUrl, /models%5B%5D=gpt-5.6-luna/);
  assert.deepEqual(result, {
    status: "RECORDED",
    inputTokens: 70000,
    cachedInputTokens: 50000,
    outputTokens: 7000,
    totalTokens: 77000,
    modelRequests: 3,
    startTimeUnix: 100,
    endTimeUnix: 160,
    model: "gpt-5.6-luna",
    apiKeyId: "key_benchmark",
  });
});

test("usage reconciler reports unavailable when provider has no recorded usage yet", async () => {
  const fetchImpl: OpenAIUsageFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { object: "page", data: [], has_more: false };
    },
  });

  const reconciler = new OpenAIUsageReconciler(
    { enabled: true, adminKey: "admin-test-key" },
    fetchImpl,
  );

  const result = await reconciler.reconcile({
    startTimeUnix: 100,
    endTimeUnix: 160,
    projectId: "proj_benchmark",
  });

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.totalTokens, 0);
});
