const GSM_7_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
  )
);

const GSM_7_EXTENDED = new Set(
  Array.from("^{}\\[~]|€\f")
);

export const DEFAULT_TWILIO_SMS_SEGMENT_COST_USD = 0.054;

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsSegmentEstimate = {
  encoding: SmsEncoding;
  units: number;
  segments: number;
};

export function estimateSmsSegments(
  body: string | null | undefined
): SmsSegmentEstimate {
  const text = String(body ?? "");

  if (!text) {
    return {
      encoding: "GSM-7",
      units: 0,
      segments: 0,
    };
  }

  let gsmUnits = 0;
  let isGsm7 = true;

  for (const char of text) {
    if (GSM_7_BASIC.has(char)) {
      gsmUnits += 1;
      continue;
    }

    if (GSM_7_EXTENDED.has(char)) {
      gsmUnits += 2;
      continue;
    }

    isGsm7 = false;
    break;
  }

  if (isGsm7) {
    return {
      encoding: "GSM-7",
      units: gsmUnits,
      segments:
        gsmUnits <= 160
          ? 1
          : Math.ceil(gsmUnits / 153),
    };
  }

  // JavaScript string.length counts UTF-16 code units, which is the
  // conservative unit used here for UCS-2/Unicode SMS segmentation.
  const ucs2Units = text.length;

  return {
    encoding: "UCS-2",
    units: ucs2Units,
    segments:
      ucs2Units <= 70
        ? 1
        : Math.ceil(ucs2Units / 67),
  };
}

export function getTwilioSmsSegmentCostUsd(
  env: NodeJS.ProcessEnv = process.env
) {
  const configured = Number(
    env.TWILIO_SMS_SEGMENT_COST_USD
  );

  if (
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return configured;
  }

  return DEFAULT_TWILIO_SMS_SEGMENT_COST_USD;
}

export function summarizeSmsFinancialTelemetry(
  messages: Array<{
    body: string | null | undefined;
  }>,
  env: NodeJS.ProcessEnv = process.env
) {
  let totalSegments = 0;
  let gsm7Messages = 0;
  let ucs2Messages = 0;

  for (const message of messages) {
    const estimate = estimateSmsSegments(
      message.body
    );

    totalSegments += estimate.segments;

    if (estimate.encoding === "GSM-7") {
      gsm7Messages += 1;
    } else {
      ucs2Messages += 1;
    }
  }

  const segmentRateUsd =
    getTwilioSmsSegmentCostUsd(env);

  return {
    totalMessages: messages.length,
    totalSegments,
    gsm7Messages,
    ucs2Messages,
    segmentRateUsd,
    estimatedCostUsd:
      totalSegments * segmentRateUsd,
  };
}
