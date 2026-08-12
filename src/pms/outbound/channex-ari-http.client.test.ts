import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS,
  CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS,
  sendChannexAriHttpRequest,
  type ChannexAriHttpResponse,
  type ChannexAriHttpTransport,
} from "./channex-ari-http.client";
import { CHANNEX_ARI_MAX_REQUEST_BYTES } from "./channex-ari-lifecycle.policy";

const RECEIVED_AT = new Date("2026-07-28T12:00:00.000Z");
const API_KEY = "secret-channex-api-key";

function availabilityPayload() {
  return {
    values: [
      {
        property_id: "channex-property-1",
        room_type_id: "room-type-1",
        date: "2026-08-01",
        availability: 1,
      },
    ],
  };
}

function restrictionsPayload() {
  return {
    values: [
      {
        property_id: "channex-property-1",
        rate_plan_id: "rate-plan-1",
        date: "2026-08-01",
        rate: "199.00",
        min_stay_arrival: 2,
        min_stay_through: 2,
        max_stay: 14,
      },
    ],
  };
}

function createMockTransport(
  handler: (
    url: string,
    data: unknown,
    config: {
      headers: Record<string, string>;
      timeout: number;
      validateStatus: (status: number) => boolean;
      maxBodyLength: number;
      maxContentLength: number;
    }
  ) => Promise<ChannexAriHttpResponse>
) {
  const calls: Array<{
    url: string;
    data: unknown;
    config: {
      headers: Record<string, string>;
      timeout: number;
      validateStatus: (status: number) => boolean;
      maxBodyLength: number;
      maxContentLength: number;
    };
  }> = [];

  const transport: ChannexAriHttpTransport = {
    post: async (url, data, config) => {
      calls.push({ url, data, config });
      return handler(url, data, config);
    },
  };

  return { transport, calls };
}

test("posts Availability with the certified endpoint, headers and limits", async () => {
  const payload = availabilityPayload();
  const mock = createMockTransport(async () => ({
    status: 200,
    data: {
      data: {
        id: "task-availability-1",
      },
    },
    headers: {
      "x-request-id": "request-availability-1",
    },
  }));

  const result = await sendChannexAriHttpRequest({
    messageKind: "AVAILABILITY",
    payload,
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test/",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  assert.equal(mock.calls.length, 1);
  assert.equal(
    mock.calls[0].url,
    "https://staging.example.test/api/v1/availability"
  );
  assert.deepEqual(mock.calls[0].data, payload);
  assert.deepEqual(mock.calls[0].config.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "user-api-key": API_KEY,
  });
  assert.equal(mock.calls[0].config.timeout, CHANNEX_ARI_HTTP_DEFAULT_TIMEOUT_MS);
  assert.equal(mock.calls[0].config.maxBodyLength, CHANNEX_ARI_MAX_REQUEST_BYTES);
  assert.equal(
    mock.calls[0].config.maxContentLength,
    CHANNEX_ARI_MAX_REQUEST_BYTES
  );
  assert.equal(mock.calls[0].config.validateStatus(200), true);
  assert.equal(mock.calls[0].config.validateStatus(429), true);
  assert.equal(mock.calls[0].config.validateStatus(503), true);

  assert.deepEqual(result, {
    endpoint: "/api/v1/availability",
    url: "https://staging.example.test/api/v1/availability",
    payloadBytes,
    evidence: {
      httpStatus: 200,
      taskId: "task-availability-1",
      warningCount: 0,
      retryAfterMs: null,
      errorCode: null,
      errorSummary: null,
      responseMeta: {
        endpoint: "/api/v1/availability",
        method: "POST",
        messageKind: "AVAILABILITY",
        payloadBytes,
        responseDataType: "object",
        retryAfterHeaderPresent: false,
        receivedAt: RECEIVED_AT.toISOString(),
        responseHeaders: {
          "x-request-id": "request-availability-1",
        },
        rawResponseText: '{"data":{"id":"task-availability-1"}}',
        requestId: "request-availability-1",
      },
    },
  });
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("extracts the task ID from the Channex task resource array", async () => {
  const payload = availabilityPayload();

  const responseBody = {
    data: [
      {
        id: "60d10993-1013-4ff2-815f-5cf3e0322901",
        type: "task",
      },
    ],
    meta: {
      message: "Success",
    },
  };

  const mock = createMockTransport(async () => ({
    status: 200,
    data: responseBody,
    headers: {
      "x-request-id": "request-task-array-1",
      "content-type": "application/json; charset=utf-8",
    },
  }));

  const result = await sendChannexAriHttpRequest({
    messageKind: "AVAILABILITY",
    payload,
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(mock.calls.length, 1);
  assert.equal(result.evidence.httpStatus, 200);
  assert.equal(result.evidence.warningCount, 0);
  assert.equal(
    result.evidence.taskId,
    "60d10993-1013-4ff2-815f-5cf3e0322901"
  );
  assert.equal(
    result.evidence.responseMeta.rawResponseText,
    JSON.stringify(responseBody)
  );
  assert.equal(
    result.evidence.responseMeta.requestId,
    "request-task-array-1"
  );
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("posts Rates & Restrictions independently with custom timeout", async () => {
  const payload = restrictionsPayload();
  const mock = createMockTransport(async () => ({
    status: 202,
    data: {
      task_id: "task-restrictions-1",
    },
    headers: {
      get(name: string) {
        return name.toLowerCase() === "x-request-id"
          ? "request-restrictions-1"
          : null;
      },
    },
  }));

  const result = await sendChannexAriHttpRequest({
    messageKind: "RATES_RESTRICTIONS",
    payload,
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    timeoutMs: 25_000,
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(
    mock.calls[0].url,
    "https://staging.example.test/api/v1/restrictions"
  );
  assert.equal(mock.calls[0].config.timeout, 25_000);
  assert.equal(result.endpoint, "/api/v1/restrictions");
  assert.equal(result.evidence.httpStatus, 202);
  assert.equal(result.evidence.taskId, "task-restrictions-1");
  assert.equal(result.evidence.warningCount, 0);
  assert.deepEqual(result.evidence.responseMeta, {
    endpoint: "/api/v1/restrictions",
    method: "POST",
    messageKind: "RATES_RESTRICTIONS",
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    responseDataType: "object",
    retryAfterHeaderPresent: false,
    receivedAt: RECEIVED_AT.toISOString(),
    responseHeaders: {},
    rawResponseText: '{"task_id":"task-restrictions-1"}',
    requestId: "request-restrictions-1",
  });
});

test(
  "retains the complete ARI response while excluding sensitive response headers",
  async () => {
    const payload = restrictionsPayload();

    const mock = createMockTransport(async () => ({
      status: 200,
      data: {
        task_id: "task-sensitive-headers-1",
        meta: {
          message: "Success",
        },
      },
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-sensitive-headers-1",
        authorization: "Bearer must-not-leak",
        "proxy-authorization": "Proxy must-not-leak",
        cookie: "session=must-not-leak",
        "set-cookie": "session=must-not-leak",
        "user-api-key": "must-not-leak",
        "x-api-key": "must-not-leak",
        get(name: string) {
          return name.toLowerCase() === "x-request-id"
            ? "request-sensitive-headers-1"
            : null;
        },
      },
    }));

    const result = await sendChannexAriHttpRequest({
      messageKind: "RATES_RESTRICTIONS",
      payload,
      apiKey: API_KEY,
      baseUrl: "https://staging.example.test",
      receivedAt: RECEIVED_AT,
      transport: mock.transport,
    });

    const responseMeta = result.evidence.responseMeta as Record<
      string,
      unknown
    >;

    assert.equal(result.evidence.httpStatus, 200);
    assert.equal(result.evidence.taskId, "task-sensitive-headers-1");

    assert.deepEqual(responseMeta.responseHeaders, {
      "content-type": "application/json",
      "x-request-id": "request-sensitive-headers-1",
    });

    assert.equal(
      responseMeta.rawResponseText,
      '{"task_id":"task-sensitive-headers-1","meta":{"message":"Success"}}'
    );

    assert.equal(responseMeta.receivedAt, RECEIVED_AT.toISOString());
    assert.equal(
      responseMeta.requestId,
      "request-sensitive-headers-1"
    );

    assert.deepEqual(mock.calls[0].data, payload);

    const serializedEvidence = JSON.stringify(result.evidence);

    assert.equal(serializedEvidence.includes("must-not-leak"), false);
    assert.equal(serializedEvidence.includes(API_KEY), false);
    assert.equal(serializedEvidence.includes('"get"'), false);
  }
);

test("preserves rejected-value warnings from an HTTP 200 response", async () => {
  const mock = createMockTransport(async () => ({
    status: 200,
    data: {
      task_id: "task-warning-1",
      warnings: [
        { field: "rate", date: "2026-08-01" },
        { field: "max_stay", date: "2026-08-02" },
      ],
      rejected_values: [{ field: "rate" }],
      code: "VALUE_REJECTED",
      message: "Some ARI values were rejected.",
    },
  }));

  const result = await sendChannexAriHttpRequest({
    messageKind: "RATES_RESTRICTIONS",
    payload: restrictionsPayload(),
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(result.evidence.httpStatus, 200);
  assert.equal(result.evidence.taskId, "task-warning-1");
  assert.equal(result.evidence.warningCount, 2);
  assert.equal(result.evidence.errorCode, "VALUE_REJECTED");
  assert.equal(
    result.evidence.errorSummary,
    "Some ARI values were rejected."
  );
});

test("normalizes HTTP 429 with numeric Retry-After and public error evidence", async () => {
  const mock = createMockTransport(async () => ({
    status: 429,
    data: {
      errors: [
        {
          code: "RATE_LIMITED",
          detail: "Slow down and retry later.",
        },
      ],
    },
    headers: {
      "retry-after": "180",
      "x-correlation-id": "correlation-429",
    },
  }));

  const result = await sendChannexAriHttpRequest({
    messageKind: "AVAILABILITY",
    payload: availabilityPayload(),
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(result.evidence.httpStatus, 429);
  assert.equal(result.evidence.taskId, null);
  assert.equal(result.evidence.warningCount, 0);
  assert.equal(result.evidence.retryAfterMs, 180_000);
  assert.equal(result.evidence.errorCode, "RATE_LIMITED");
  assert.equal(result.evidence.errorSummary, "Slow down and retry later.");
  assert.deepEqual(result.evidence.responseMeta, {
    endpoint: "/api/v1/availability",
    method: "POST",
    messageKind: "AVAILABILITY",
    payloadBytes: Buffer.byteLength(
      JSON.stringify(availabilityPayload()),
      "utf8"
    ),
    responseDataType: "object",
    retryAfterHeaderPresent: true,
    receivedAt: RECEIVED_AT.toISOString(),
    responseHeaders: {
      "retry-after": "180",
      "x-correlation-id": "correlation-429",
    },
    rawResponseText:
      '{"errors":[{"code":"RATE_LIMITED","detail":"Slow down and retry later."}]}',
    requestId: "correlation-429",
  });
});

test("parses HTTP-date Retry-After relative to the recorded receipt time", async () => {
  const mock = createMockTransport(async () => ({
    status: 429,
    data: {},
    headers: {
      "Retry-After": "Tue, 28 Jul 2026 12:03:00 GMT",
    },
  }));

  const result = await sendChannexAriHttpRequest({
    messageKind: "AVAILABILITY",
    payload: availabilityPayload(),
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(result.evidence.retryAfterMs, 180_000);
});

test("normalizes a rejected Axios-style 5xx response instead of throwing", async () => {
  const mock = createMockTransport(async () => {
    throw {
      response: {
        status: 503,
        data: {
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Channex is temporarily unavailable.",
          },
        },
        headers: {
          "cf-ray": "cloudflare-ray-1",
        },
      },
    };
  });

  const result = await sendChannexAriHttpRequest({
    messageKind: "RATES_RESTRICTIONS",
    payload: restrictionsPayload(),
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(result.evidence.httpStatus, 503);
  assert.equal(result.evidence.errorCode, "UPSTREAM_UNAVAILABLE");
  assert.equal(
    result.evidence.errorSummary,
    "Channex is temporarily unavailable."
  );
  assert.equal(
    (result.evidence.responseMeta as Record<string, unknown>).requestId,
    "cloudflare-ray-1"
  );
});

test("normalizes timeout evidence without exposing the thrown error", async () => {
  const mock = createMockTransport(async () => {
    throw {
      code: "ECONNABORTED",
      message: "timeout of 15000ms exceeded",
      secret: "must-not-leak",
    };
  });

  const result = await sendChannexAriHttpRequest({
    messageKind: "AVAILABILITY",
    payload: availabilityPayload(),
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.deepEqual(result.evidence, {
    httpStatus: null,
    networkError: false,
    timedOut: true,
    taskId: null,
    warningCount: 0,
    retryAfterMs: null,
    responseMeta: {
      endpoint: "/api/v1/availability",
      method: "POST",
      messageKind: "AVAILABILITY",
      payloadBytes: Buffer.byteLength(
        JSON.stringify(availabilityPayload()),
        "utf8"
      ),
      transportFailure: true,
      transportCode: "ECONNABORTED",
    },
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("normalizes non-timeout network evidence", async () => {
  const mock = createMockTransport(async () => {
    throw {
      code: "ECONNRESET",
      message: "socket hang up",
    };
  });

  const result = await sendChannexAriHttpRequest({
    messageKind: "RATES_RESTRICTIONS",
    payload: restrictionsPayload(),
    apiKey: API_KEY,
    baseUrl: "https://staging.example.test",
    receivedAt: RECEIVED_AT,
    transport: mock.transport,
  });

  assert.equal(result.evidence.httpStatus, null);
  assert.equal(result.evidence.networkError, true);
  assert.equal(result.evidence.timedOut, false);
  assert.deepEqual(result.evidence.responseMeta, {
    endpoint: "/api/v1/restrictions",
    method: "POST",
    messageKind: "RATES_RESTRICTIONS",
    payloadBytes: Buffer.byteLength(
      JSON.stringify(restrictionsPayload()),
      "utf8"
    ),
    transportFailure: true,
    transportCode: "ECONNRESET",
  });
});

test("rejects invalid configuration and payload before transport", async () => {
  const mock = createMockTransport(async () => ({ status: 200, data: {} }));

  const invalidInputs = [
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: " ",
        baseUrl: "https://staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_API_KEY_REQUIRED/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: "x".repeat(4_097),
        baseUrl: "https://staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_API_KEY_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "ftp://staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_BASE_URL_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "https://user:password@staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_BASE_URL_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test?secret=true",
      },
      error: /CHANNEX_ARI_HTTP_BASE_URL_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test",
        timeoutMs: 999,
      },
      error: /CHANNEX_ARI_HTTP_TIMEOUT_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test",
        timeoutMs: CHANNEX_ARI_HTTP_MAX_TIMEOUT_MS + 1,
      },
      error: /CHANNEX_ARI_HTTP_TIMEOUT_INVALID/,
    },
    {
      input: {
        messageKind: "INVALID" as "AVAILABILITY",
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_MESSAGE_KIND_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: { values: [] },
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_PAYLOAD_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: null,
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test",
      },
      error: /CHANNEX_ARI_HTTP_PAYLOAD_INVALID/,
    },
    {
      input: {
        messageKind: "AVAILABILITY" as const,
        payload: availabilityPayload(),
        apiKey: API_KEY,
        baseUrl: "https://staging.example.test",
        receivedAt: new Date("invalid"),
      },
      error: /CHANNEX_ARI_HTTP_RECEIVED_AT_INVALID/,
    },
  ];

  for (const invalid of invalidInputs) {
    await assert.rejects(
      () =>
        sendChannexAriHttpRequest({
          ...invalid.input,
          transport: mock.transport,
        }),
      invalid.error
    );
  }

  assert.equal(mock.calls.length, 0);
});

// CHANNEX_ARI_BENIGN_SINGULAR_WARNING_CONTRACT_V1

test(
  "does not classify singular warning Success as rejected-value evidence",
  async () => {
    const mock = createMockTransport(async () => ({
      status: 200,
      data: {
        success: true,
        warning: "Success",
        message: "Success",
      },
      headers: {
        "x-request-id":
          "request-benign-singular-warning",
      },
    }));

    const result =
      await sendChannexAriHttpRequest({
        messageKind:
          "RATES_RESTRICTIONS",
        payload:
          restrictionsPayload(),
        apiKey:
          API_KEY,
        baseUrl:
          "https://staging.example.test",
        receivedAt:
          RECEIVED_AT,
        transport:
          mock.transport,
      });

    assert.equal(
      result.evidence.httpStatus,
      200
    );

    assert.equal(
      result.evidence.warningCount,
      0
    );

    assert.equal(
      result.evidence.errorCode,
      null
    );

    assert.equal(
      result.evidence.errorSummary,
      null
    );
  }
);

test(
  "preserves structured warnings arrays as rejected-value evidence",
  async () => {
    const mock = createMockTransport(async () => ({
      status: 200,
      data: {
        warnings: [
          {
            field: "rate",
            date: "2026-08-22",
          },
        ],
        code: "VALUE_REJECTED",
        message:
          "One ARI value was rejected.",
      },
    }));

    const result =
      await sendChannexAriHttpRequest({
        messageKind:
          "RATES_RESTRICTIONS",
        payload:
          restrictionsPayload(),
        apiKey:
          API_KEY,
        baseUrl:
          "https://staging.example.test",
        receivedAt:
          RECEIVED_AT,
        transport:
          mock.transport,
      });

    assert.equal(
      result.evidence.warningCount,
      1
    );

    assert.equal(
      result.evidence.errorCode,
      "VALUE_REJECTED"
    );

    assert.equal(
      result.evidence.errorSummary,
      "One ARI value was rejected."
    );
  }
);

test(
  "preserves rejected_values arrays as rejected-value evidence",
  async () => {
    const mock = createMockTransport(async () => ({
      status: 200,
      data: {
        rejected_values: [
          {
            field: "rate",
            date: "2026-08-22",
          },
          {
            field: "max_stay",
            date: "2026-08-23",
          },
        ],
        code: "VALUE_REJECTED",
        message:
          "Two ARI values were rejected.",
      },
    }));

    const result =
      await sendChannexAriHttpRequest({
        messageKind:
          "RATES_RESTRICTIONS",
        payload:
          restrictionsPayload(),
        apiKey:
          API_KEY,
        baseUrl:
          "https://staging.example.test",
        receivedAt:
          RECEIVED_AT,
        transport:
          mock.transport,
      });

    assert.equal(
      result.evidence.warningCount,
      2
    );

    assert.equal(
      result.evidence.errorCode,
      "VALUE_REJECTED"
    );

    assert.equal(
      result.evidence.errorSummary,
      "Two ARI values were rejected."
    );
  }
);
