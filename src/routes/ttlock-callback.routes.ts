import { Router } from "express";

import {
  isTtlockCallbackContentType,
  normalizeTtlockCallbackForm,
  ttlockCallbackFingerprint,
  ttlockCallbackSafeMetadata,
  ttlockCallbackTokenMatches,
} from "../ttlock/ttlock.callback";

export type TtlockCallbackCanaryEvaluation =
  | {
      status: 200;
      body: "success";
      accepted: true;
      fingerprint: string;
      metadata: ReturnType<typeof ttlockCallbackSafeMetadata>;
    }
  | {
      status: 400 | 401 | 415 | 503;
      body: string;
      accepted: false;
    };

export function evaluateTtlockCallbackCanary(input: {
  expectedToken?: string | null;
  receivedToken: unknown;
  contentType: unknown;
  body: unknown;
}): TtlockCallbackCanaryEvaluation {
  const expectedToken = String(input.expectedToken ?? "").trim();

  if (!expectedToken) {
    return {
      status: 503,
      body: "callback unavailable",
      accepted: false,
    };
  }

  if (
    !ttlockCallbackTokenMatches({
      expectedToken,
      receivedToken: input.receivedToken,
    })
  ) {
    return {
      status: 401,
      body: "unauthorized",
      accepted: false,
    };
  }

  if (!isTtlockCallbackContentType(input.contentType)) {
    return {
      status: 415,
      body: "unsupported media type",
      accepted: false,
    };
  }

  const form = normalizeTtlockCallbackForm(input.body);

  if (Object.keys(form).length === 0) {
    return {
      status: 400,
      body: "invalid callback payload",
      accepted: false,
    };
  }

  return {
    status: 200,
    body: "success",
    accepted: true,
    fingerprint: ttlockCallbackFingerprint(form),
    metadata: ttlockCallbackSafeMetadata(form),
  };
}

export function buildTtlockCallbackCanaryRouter(
  env: NodeJS.ProcessEnv = process.env
) {
  const router = Router();

  router.post("/webhooks/ttlock", (req, res) => {
    const result = evaluateTtlockCallbackCanary({
      expectedToken: env.TTLOCK_CALLBACK_TOKEN,
      receivedToken: req.query.token,
      contentType: req.headers["content-type"],
      body: req.body,
    });

    if (!result.accepted) {
      console.warn("[ttlock.callback.canary] rejected", {
        status: result.status,
        reason: result.body,
      });

      return res
        .status(result.status)
        .type("text/plain")
        .send(result.body);
    }

    console.log("[ttlock.callback.canary] received", {
      fingerprint: result.fingerprint,
      ...result.metadata,
    });

    return res
      .status(200)
      .type("text/plain")
      .send("success");
  });

  return router;
}
