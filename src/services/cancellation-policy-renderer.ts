export type CancellationPolicyLanguage = "en" | "es";

export type CancellationPolicyTypeValue =
  | "FLEXIBLE"
  | "MODERATE"
  | "FIRM"
  | "STRICT"
  | "CUSTOM"
  | "NON_REFUNDABLE";

export type CancellationRefundBasisValue =
  | "TOTAL_AMOUNT"
  | "NIGHTLY_SUBTOTAL"
  | "NIGHTLY_PLUS_CLEANING"
  | "CUSTOM";

export type CancellationNonRefundableScenario =
  | "EARLY_DEPARTURE"
  | "DELAYED_ARRIVAL"
  | "REDUCED_NIGHTS"
  | "WEATHER_RE_SCHEDULE"
  | "OTHER";

export type CancellationPolicyRule = {
  minHoursBeforeCheckIn: number;
  refundPercent: number;
};

export type CancellationPolicyModel = {
  type: CancellationPolicyTypeValue;
  refundBasis: CancellationRefundBasisValue;
  refundRules: CancellationPolicyRule[];
  nonRefundableScenarios: CancellationNonRefundableScenario[];
  guestSelfCancellationEnabled: boolean;
  autoRefundEligibleCancellations: boolean;
  requireHostApprovalOutsidePolicy: boolean;
  cleaningFeeRefundable: boolean;
  amenitiesRefundable: boolean;
  taxesRefundable: boolean;
};

export type RenderCancellationPolicyInput = {
  policy: CancellationPolicyModel;
  preferredLanguage?: string | null;
  checkIn?: Date | string | null;
};

export type RenderedCancellationRule = {
  minHoursBeforeCheckIn: number;
  refundPercent: number;
  label: string;
  windowLabel: string;
  description: string;
};

export type RenderedCancellationTimelineItem = {
  minHoursBeforeCheckIn: number;
  maxHoursBeforeCheckIn: number | null;
  refundPercent: number;
  title: string;
  description: string;
};

export type RenderedCancellationScenario = {
  code: CancellationNonRefundableScenario;
  label: string;
  description: string;
};

export type RenderedCancellationPolicy = {
  language: CancellationPolicyLanguage;
  title: string;
  headline: string;
  summary: string;
  timeline: RenderedCancellationTimelineItem[];
  rules: RenderedCancellationRule[];
  nonRefundableScenarios: RenderedCancellationScenario[];
  nonRefundableScenarioDisclosure: string | null;
  refundBasisDisclosure: string;
  approvalNote: string | null;
  automationNote: string | null;
  selfCancellationNote: string | null;
  feeDisclosure: string;
  acceptanceText: string;
  checkIn: string | null;
};

type CancellationPolicyLanguagePack = {
  policyTitles: Record<CancellationPolicyTypeValue, string>;
  fullRefundTitle: string;
  fullRefundPhrase: string;
  partialRefundTitle: (percent: string) => string;
  partialRefundPhrase: (percent: string) => string;
  noRefundTitle: string;
  noRefundPhrase: string;
  atLeastBeforeCheckIn: (window: string) => string;
  betweenBeforeCheckIn: (minimum: string, maximum: string) => string;
  lessThanBeforeCheckIn: (window: string) => string;
  afterBooking: string;
  ruleDescriptions: {
    atLeast: (window: string, refund: string) => string;
    between: (minimum: string, maximum: string, refund: string) => string;
    lessThan: (window: string, refund: string) => string;
    afterBooking: (refund: string) => string;
  };
  summary: {
    nonRefundable: string;
    singleRule: (description: string) => string;
    multipleRules: (descriptions: string) => string;
  };
  headline: {
    refundable: string;
    nonRefundable: string;
  };
  refundBasis: Record<CancellationRefundBasisValue, string>;
  scenarios: Record<
    CancellationNonRefundableScenario,
    {
      label: string;
      description: string;
    }
  >;
  scenarioDisclosure: (scenarioLabels: string) => string;
  approvalRequired: string;
  noApprovalRequired: string;
  automaticRefund: string;
  manualRefundReview: string;
  guestSelfCancellationEnabled: string;
  guestSelfCancellationDisabled: string;
  feeDisclosure: (parts: string[]) => string;
  refundableFeeLabels: {
    cleaning: string;
    amenities: string;
    taxes: string;
  };
  nonRefundableFeeLabels: {
    cleaning: string;
    amenities: string;
    taxes: string;
  };
  acceptanceText: string;
  and: string;
  day: string;
  days: string;
  hour: string;
  hours: string;
};

const LANGUAGE_PACKS: Record<
  CancellationPolicyLanguage,
  CancellationPolicyLanguagePack
> = {
  en: {
    policyTitles: {
      FLEXIBLE: "Flexible cancellation policy",
      MODERATE: "Moderate cancellation policy",
      FIRM: "Firm cancellation policy",
      STRICT: "Strict cancellation policy",
      CUSTOM: "Custom cancellation policy",
      NON_REFUNDABLE: "Non-refundable cancellation policy",
    },

    fullRefundTitle: "Full refund",
    fullRefundPhrase: "a full refund",

    partialRefundTitle: (percent) => `${percent} refund`,
    partialRefundPhrase: (percent) => `a ${percent} refund`,

    noRefundTitle: "No refund",
    noRefundPhrase: "no refund",

    atLeastBeforeCheckIn: (window) =>
      `${window} or more before check-in`,

    betweenBeforeCheckIn: (minimum, maximum) =>
      `Between ${minimum} and ${maximum} before check-in`,

    lessThanBeforeCheckIn: (window) =>
      `Less than ${window} before check-in`,

    afterBooking: "After booking",

    ruleDescriptions: {
      atLeast: (window, refund) =>
        `Cancel at least ${window} before check-in to receive ${refund}.`,

      between: (minimum, maximum, refund) =>
        `Cancel between ${minimum} and ${maximum} before check-in to receive ${refund}.`,

      lessThan: (window, refund) =>
        `Cancel less than ${window} before check-in to receive ${refund}.`,

      afterBooking: (refund) =>
        `After booking, eligible cancellations receive ${refund}.`,
    },

    summary: {
      nonRefundable:
        "This reservation is non-refundable under the configured cancellation policy.",

      singleRule: (description) => description,

      multipleRules: (descriptions) => descriptions,
    },

    headline: {
      refundable:
        "Refund eligibility depends on when the reservation is cancelled.",

      nonRefundable:
        "This reservation does not include a standard cancellation refund.",
    },

    refundBasis: {
      TOTAL_AMOUNT:
        "Eligible refunds are calculated from the total reservation amount.",

      NIGHTLY_SUBTOTAL:
        "Eligible refunds are calculated from the nightly accommodation subtotal.",

      NIGHTLY_PLUS_CLEANING:
        "Eligible refunds are calculated from the nightly accommodation subtotal and cleaning fee.",

      CUSTOM:
        "Eligible refunds are calculated using the refund basis configured for this property.",
    },

    scenarios: {
      EARLY_DEPARTURE: {
        label: "Early departure",
        description:
          "Unused nights caused by an early departure are not refundable.",
      },

      DELAYED_ARRIVAL: {
        label: "Delayed arrival",
        description:
          "Unused nights caused by a delayed arrival are not refundable.",
      },

      REDUCED_NIGHTS: {
        label: "Reduced stay",
        description:
          "Reducing the number of reserved nights after booking is not refundable.",
      },

      WEATHER_RE_SCHEDULE: {
        label: "Weather-related reschedule",
        description:
          "Weather-related rescheduling does not automatically qualify for a refund.",
      },

      OTHER: {
        label: "Other post-booking changes",
        description:
          "Other changes requested after booking do not automatically qualify for a refund.",
      },
    },

    scenarioDisclosure: (scenarioLabels) =>
      `No refund applies to the following post-booking scenarios: ${scenarioLabels}.`,

    approvalRequired:
      "Requests outside the configured policy require host approval.",

    noApprovalRequired:
      "Requests outside the configured policy are handled according to Pin&Go's configured automation rules.",

    automaticRefund:
      "Eligible cancellations may be refunded automatically.",

    manualRefundReview:
      "Eligible refunds require review before they are processed.",

    guestSelfCancellationEnabled:
      "The guest may submit an eligible cancellation through the Guest Portal.",

    guestSelfCancellationDisabled:
      "The guest must contact Pin&Go Guest Services to request a cancellation.",

    feeDisclosure: (parts) => parts.join(" "),

    refundableFeeLabels: {
      cleaning: "The cleaning fee is refundable when the policy allows a refund.",
      amenities:
        "Eligible amenity charges are refundable when the policy allows a refund.",
      taxes: "Eligible taxes are refundable when the policy allows a refund.",
    },

    nonRefundableFeeLabels: {
      cleaning: "The cleaning fee is not refundable.",
      amenities: "Amenity charges are not refundable.",
      taxes: "Taxes are not refundable.",
    },

    acceptanceText:
      "I understand and accept the cancellation and refund policy that applies to this reservation.",

    and: "and",
    day: "day",
    days: "days",
    hour: "hour",
    hours: "hours",
  },

  es: {
    policyTitles: {
      FLEXIBLE: "Política de cancelación flexible",
      MODERATE: "Política de cancelación moderada",
      FIRM: "Política de cancelación firme",
      STRICT: "Política de cancelación estricta",
      CUSTOM: "Política de cancelación personalizada",
      NON_REFUNDABLE: "Política de cancelación no reembolsable",
    },

    fullRefundTitle: "Reembolso completo",
    fullRefundPhrase: "un reembolso completo",

    partialRefundTitle: (percent) => `Reembolso del ${percent}`,
    partialRefundPhrase: (percent) => `un reembolso del ${percent}`,

    noRefundTitle: "Sin reembolso",
    noRefundPhrase: "ningún reembolso",

    atLeastBeforeCheckIn: (window) =>
      `${window} o más antes de la entrada`,

    betweenBeforeCheckIn: (minimum, maximum) =>
      `Entre ${minimum} y ${maximum} antes de la entrada`,

    lessThanBeforeCheckIn: (window) =>
      `Menos de ${window} antes de la entrada`,

    afterBooking: "Después de reservar",

    ruleDescriptions: {
      atLeast: (window, refund) =>
        `Cancele al menos ${window} antes de la entrada para recibir ${refund}.`,

      between: (minimum, maximum, refund) =>
        `Cancele entre ${minimum} y ${maximum} antes de la entrada para recibir ${refund}.`,

      lessThan: (window, refund) =>
        `Cancele menos de ${window} antes de la entrada para recibir ${refund}.`,

      afterBooking: (refund) =>
        `Después de reservar, las cancelaciones elegibles reciben ${refund}.`,
    },

    summary: {
      nonRefundable:
        "Esta reservación no es reembolsable según la política de cancelación configurada.",

      singleRule: (description) => description,

      multipleRules: (descriptions) => descriptions,
    },

    headline: {
      refundable:
        "La elegibilidad del reembolso depende del momento en que se cancele la reservación.",

      nonRefundable:
        "Esta reservación no incluye un reembolso estándar por cancelación.",
    },

    refundBasis: {
      TOTAL_AMOUNT:
        "Los reembolsos elegibles se calculan sobre el importe total de la reservación.",

      NIGHTLY_SUBTOTAL:
        "Los reembolsos elegibles se calculan sobre el subtotal del alojamiento.",

      NIGHTLY_PLUS_CLEANING:
        "Los reembolsos elegibles se calculan sobre el subtotal del alojamiento y el cargo de limpieza.",

      CUSTOM:
        "Los reembolsos elegibles se calculan utilizando la base configurada para esta propiedad.",
    },

    scenarios: {
      EARLY_DEPARTURE: {
        label: "Salida anticipada",
        description:
          "Las noches no utilizadas por una salida anticipada no son reembolsables.",
      },

      DELAYED_ARRIVAL: {
        label: "Llegada retrasada",
        description:
          "Las noches no utilizadas por una llegada retrasada no son reembolsables.",
      },

      REDUCED_NIGHTS: {
        label: "Reducción de la estadía",
        description:
          "Reducir la cantidad de noches reservadas después de confirmar la reservación no es reembolsable.",
      },

      WEATHER_RE_SCHEDULE: {
        label: "Cambio de fecha por condiciones del tiempo",
        description:
          "Los cambios de fecha relacionados con condiciones del tiempo no cualifican automáticamente para un reembolso.",
      },

      OTHER: {
        label: "Otros cambios posteriores a la reservación",
        description:
          "Otros cambios solicitados después de reservar no cualifican automáticamente para un reembolso.",
      },
    },

    scenarioDisclosure: (scenarioLabels) =>
      `No aplica reembolso en los siguientes escenarios posteriores a la reservación: ${scenarioLabels}.`,

    approvalRequired:
      "Las solicitudes fuera de la política configurada requieren la aprobación del host.",

    noApprovalRequired:
      "Las solicitudes fuera de la política configurada se gestionan según las reglas de automatización de Pin&Go.",

    automaticRefund:
      "Las cancelaciones elegibles pueden reembolsarse automáticamente.",

    manualRefundReview:
      "Los reembolsos elegibles requieren revisión antes de ser procesados.",

    guestSelfCancellationEnabled:
      "El huésped puede solicitar una cancelación elegible desde el Guest Portal.",

    guestSelfCancellationDisabled:
      "El huésped debe comunicarse con Pin&Go Guest Services para solicitar una cancelación.",

    feeDisclosure: (parts) => parts.join(" "),

    refundableFeeLabels: {
      cleaning:
        "El cargo de limpieza es reembolsable cuando la política permite un reembolso.",
      amenities:
        "Los cargos elegibles por amenidades son reembolsables cuando la política permite un reembolso.",
      taxes:
        "Los impuestos elegibles son reembolsables cuando la política permite un reembolso.",
    },

    nonRefundableFeeLabels: {
      cleaning: "El cargo de limpieza no es reembolsable.",
      amenities: "Los cargos por amenidades no son reembolsables.",
      taxes: "Los impuestos no son reembolsables.",
    },

    acceptanceText:
      "Entiendo y acepto la política de cancelación y reembolso aplicable a esta reservación.",

    and: "y",
    day: "día",
    days: "días",
    hour: "hora",
    hours: "horas",
  },
};

function resolveLanguage(
  preferredLanguage: string | null | undefined
): CancellationPolicyLanguage {
  const normalized = String(preferredLanguage ?? "")
    .trim()
    .toLowerCase();

  return normalized === "es" || normalized.startsWith("es-") ? "es" : "en";
}

function normalizeHours(value: unknown) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return 0;
  }

  return Math.max(0, Math.round(numberValue));
}

function normalizePercent(value: unknown) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, numberValue));
}

function formatPercent(value: number) {
  const normalized = normalizePercent(value);

  return Number.isInteger(normalized)
    ? `${normalized}%`
    : `${Number(normalized.toFixed(2))}%`;
}

function formatWindow(
  hours: number,
  languagePack: CancellationPolicyLanguagePack
) {
  const safeHours = normalizeHours(hours);

  if (safeHours <= 0) {
    return languagePack.afterBooking;
  }

  if (safeHours % 24 === 0) {
    const days = safeHours / 24;
    const unit = days === 1 ? languagePack.day : languagePack.days;

    return `${days} ${unit}`;
  }

  const unit = safeHours === 1 ? languagePack.hour : languagePack.hours;

  return `${safeHours} ${unit}`;
}

function formatRefundTitle(
  refundPercent: number,
  languagePack: CancellationPolicyLanguagePack
) {
  const normalizedPercent = normalizePercent(refundPercent);

  if (normalizedPercent >= 100) {
    return languagePack.fullRefundTitle;
  }

  if (normalizedPercent <= 0) {
    return languagePack.noRefundTitle;
  }

  return languagePack.partialRefundTitle(
    formatPercent(normalizedPercent)
  );
}

function formatRefundPhrase(
  refundPercent: number,
  languagePack: CancellationPolicyLanguagePack
) {
  const normalizedPercent = normalizePercent(refundPercent);

  if (normalizedPercent >= 100) {
    return languagePack.fullRefundPhrase;
  }

  if (normalizedPercent <= 0) {
    return languagePack.noRefundPhrase;
  }

  return languagePack.partialRefundPhrase(
    formatPercent(normalizedPercent)
  );
}

function normalizeRules(
  rules: CancellationPolicyRule[]
): CancellationPolicyRule[] {
  const normalized = Array.isArray(rules)
    ? rules.map((rule) => ({
        minHoursBeforeCheckIn: normalizeHours(
          rule?.minHoursBeforeCheckIn
        ),
        refundPercent: normalizePercent(rule?.refundPercent),
      }))
    : [];

  const byMinimumHours = new Map<number, CancellationPolicyRule>();

  for (const rule of normalized) {
    byMinimumHours.set(rule.minHoursBeforeCheckIn, rule);
  }

  return Array.from(byMinimumHours.values()).sort(
    (a, b) => b.minHoursBeforeCheckIn - a.minHoursBeforeCheckIn
  );
}

function renderRule({
  rule,
  index,
  rules,
  languagePack,
}: {
  rule: CancellationPolicyRule;
  index: number;
  rules: CancellationPolicyRule[];
  languagePack: CancellationPolicyLanguagePack;
}): {
  renderedRule: RenderedCancellationRule;
  timelineItem: RenderedCancellationTimelineItem;
} {
  const minimumHours = normalizeHours(rule.minHoursBeforeCheckIn);
  const previousRule = index > 0 ? rules[index - 1] : null;
  const maximumHours = previousRule
    ? normalizeHours(previousRule.minHoursBeforeCheckIn)
    : null;

  const minimumWindow = formatWindow(minimumHours, languagePack);
  const maximumWindow =
    maximumHours === null
      ? null
      : formatWindow(maximumHours, languagePack);

  const refundPhrase = formatRefundPhrase(
    rule.refundPercent,
    languagePack
  );

  let windowLabel: string;
  let description: string;

  if (rules.length === 1 && minimumHours <= 0) {
    windowLabel = languagePack.afterBooking;
    description = languagePack.ruleDescriptions.afterBooking(refundPhrase);
  } else if (index === 0) {
    windowLabel = languagePack.atLeastBeforeCheckIn(minimumWindow);
    description = languagePack.ruleDescriptions.atLeast(
      minimumWindow,
      refundPhrase
    );
  } else if (minimumHours <= 0 && maximumWindow) {
    windowLabel = languagePack.lessThanBeforeCheckIn(maximumWindow);
    description = languagePack.ruleDescriptions.lessThan(
      maximumWindow,
      refundPhrase
    );
  } else if (maximumWindow) {
    windowLabel = languagePack.betweenBeforeCheckIn(
      minimumWindow,
      maximumWindow
    );
    description = languagePack.ruleDescriptions.between(
      minimumWindow,
      maximumWindow,
      refundPhrase
    );
  } else {
    windowLabel = languagePack.afterBooking;
    description = languagePack.ruleDescriptions.afterBooking(refundPhrase);
  }

  const title = formatRefundTitle(
    rule.refundPercent,
    languagePack
  );

  return {
    renderedRule: {
      minHoursBeforeCheckIn: minimumHours,
      refundPercent: normalizePercent(rule.refundPercent),
      label: title,
      windowLabel,
      description,
    },

    timelineItem: {
      minHoursBeforeCheckIn: minimumHours,
      maxHoursBeforeCheckIn: maximumHours,
      refundPercent: normalizePercent(rule.refundPercent),
      title,
      description,
    },
  };
}

function renderScenarios(
  scenarios: CancellationNonRefundableScenario[],
  languagePack: CancellationPolicyLanguagePack
): RenderedCancellationScenario[] {
  const uniqueScenarios = Array.from(
    new Set(Array.isArray(scenarios) ? scenarios : [])
  );

  return uniqueScenarios
    .filter((scenario) => Boolean(languagePack.scenarios[scenario]))
    .map((scenario) => ({
      code: scenario,
      label: languagePack.scenarios[scenario].label,
      description: languagePack.scenarios[scenario].description,
    }));
}

function joinLabels(
  labels: string[],
  languagePack: CancellationPolicyLanguagePack
) {
  if (labels.length === 0) {
    return "";
  }

  if (labels.length === 1) {
    return labels[0];
  }

  if (labels.length === 2) {
    return `${labels[0]} ${languagePack.and} ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(", ")} ${
    languagePack.and
  } ${labels[labels.length - 1]}`;
}

function renderFeeDisclosure(
  policy: CancellationPolicyModel,
  languagePack: CancellationPolicyLanguagePack
) {
  const parts = [
    policy.cleaningFeeRefundable
      ? languagePack.refundableFeeLabels.cleaning
      : languagePack.nonRefundableFeeLabels.cleaning,

    policy.amenitiesRefundable
      ? languagePack.refundableFeeLabels.amenities
      : languagePack.nonRefundableFeeLabels.amenities,

    policy.taxesRefundable
      ? languagePack.refundableFeeLabels.taxes
      : languagePack.nonRefundableFeeLabels.taxes,
  ];

  return languagePack.feeDisclosure(parts);
}

function normalizeCheckIn(
  checkIn: Date | string | null | undefined
): string | null {
  if (!checkIn) {
    return null;
  }

  const date =
    checkIn instanceof Date ? checkIn : new Date(String(checkIn));

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function renderCancellationPolicy({
  policy,
  preferredLanguage,
  checkIn,
}: RenderCancellationPolicyInput): RenderedCancellationPolicy {
  const language = resolveLanguage(preferredLanguage);
  const languagePack = LANGUAGE_PACKS[language];

  const normalizedRules = normalizeRules(policy.refundRules);

  const renderedRules: RenderedCancellationRule[] = [];
  const timeline: RenderedCancellationTimelineItem[] = [];

  normalizedRules.forEach((rule, index) => {
    const rendered = renderRule({
      rule,
      index,
      rules: normalizedRules,
      languagePack,
    });

    renderedRules.push(rendered.renderedRule);
    timeline.push(rendered.timelineItem);
  });

  const isNonRefundable =
    policy.type === "NON_REFUNDABLE" ||
    (normalizedRules.length > 0 &&
      normalizedRules.every((rule) => rule.refundPercent <= 0));

  const ruleDescriptions = renderedRules.map(
    (rule) => rule.description
  );

  const summary = isNonRefundable
    ? languagePack.summary.nonRefundable
    : ruleDescriptions.length <= 1
    ? languagePack.summary.singleRule(ruleDescriptions[0] ?? "")
    : languagePack.summary.multipleRules(
        ruleDescriptions.join(" ")
      );

  const renderedScenarios = renderScenarios(
    policy.nonRefundableScenarios,
    languagePack
  );

  const scenarioLabels = renderedScenarios.map(
    (scenario) => scenario.label
  );

  return {
    language,
    title: languagePack.policyTitles[policy.type],
    headline: isNonRefundable
      ? languagePack.headline.nonRefundable
      : languagePack.headline.refundable,
    summary,
    timeline,
    rules: renderedRules,
    nonRefundableScenarios: renderedScenarios,
    nonRefundableScenarioDisclosure:
      scenarioLabels.length > 0
        ? languagePack.scenarioDisclosure(
            joinLabels(scenarioLabels, languagePack)
          )
        : null,
    refundBasisDisclosure:
      languagePack.refundBasis[policy.refundBasis],
    approvalNote: policy.requireHostApprovalOutsidePolicy
      ? languagePack.approvalRequired
      : languagePack.noApprovalRequired,
    automationNote: policy.autoRefundEligibleCancellations
      ? languagePack.automaticRefund
      : languagePack.manualRefundReview,
    selfCancellationNote: policy.guestSelfCancellationEnabled
      ? languagePack.guestSelfCancellationEnabled
      : languagePack.guestSelfCancellationDisabled,
    feeDisclosure: renderFeeDisclosure(policy, languagePack),
    acceptanceText: languagePack.acceptanceText,
    checkIn: normalizeCheckIn(checkIn),
  };
}