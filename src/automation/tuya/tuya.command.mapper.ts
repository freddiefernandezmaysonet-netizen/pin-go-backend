// tuya.command.mapper.ts

export type TuyaCapability =
  | "SWITCH"
  | "BRIGHTNESS"
  | "TEMPERATURE"
  | "MODE"
  | "FAN_SPEED"
  | "CURTAIN"
  | "LOCK"
  | "SCENE";

export type TuyaDeviceKind =
  | "AC"
  | "LIGHT"
  | "SWITCH"
  | "TV"
  | "CURTAIN"
  | "LOCK"
  | "ALARM"
  | "SCENE"
  | "GENERIC";

export type AutomationAction =
  | "TURN_ON"
  | "TURN_OFF"
  | "SET_TEMPERATURE"
  | "SET_BRIGHTNESS"
  | "OPEN"
  | "CLOSE"
  | "LOCK"
  | "UNLOCK"
  | "ARM"
  | "DISARM"
  | "SET_MODE"
  | "SET_FAN_SPEED"
  | "ACTIVATE_SCENE";

export type TuyaCommand = {
  code: string;
  value: string | number | boolean;
};

export type TuyaFunction = {
  code: string;
  type?: string;
  values?: string;
};

export type TuyaCommandBuildResult = {
  ok: boolean;
  deviceKind: TuyaDeviceKind;
  action: AutomationAction;
  commands: TuyaCommand[];
  warnings: string[];
  error?: string;
};

type BuildInput = {
  deviceProfile?: string | null;
  deviceKind?: string | null;
  action: string;
  value?: unknown;
  functions?: TuyaFunction[] | null;
};

// ==========================
// UTILS
// ==========================

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeUpper(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseValues(fn?: TuyaFunction) {
  try {
    return fn?.values ? JSON.parse(fn.values) : null;
  } catch {
    return null;
  }
}

function findFn(functions: TuyaFunction[] | null | undefined, candidates: string[]) {
  if (!functions) return null;

  const map = new Map(
    functions.map((f) => [normalize(f.code), f])
  );

  for (const c of candidates) {
    const fn = map.get(normalize(c));
    if (fn) return fn;
  }

  return null;
}

function scaleNumber(value: number, fn?: TuyaFunction) {
  const meta = parseValues(fn);
  if (!meta) return value;

  const scale = meta.scale ?? 0;
  return Math.round(value * Math.pow(10, scale));
}

function resolveAction(value: unknown): AutomationAction | null {
  const action = normalizeUpper(value);

  const allowed: AutomationAction[] = [
    "TURN_ON","TURN_OFF","SET_TEMPERATURE","SET_BRIGHTNESS",
    "OPEN","CLOSE","LOCK","UNLOCK","ARM","DISARM",
    "SET_MODE","SET_FAN_SPEED","ACTIVATE_SCENE"
  ];

  return allowed.includes(action as AutomationAction)
    ? (action as AutomationAction)
    : null;
}

// ==========================
// DEVICE KIND (fallback only)
// ==========================

function resolveDeviceKind(value: unknown): TuyaDeviceKind {
  const v = normalize(value);

  if (v.includes("ac") || v.includes("air")) return "AC";
  if (v.includes("light") || v.includes("dj")) return "LIGHT";
  if (v.includes("switch")) return "SWITCH";
  if (v.includes("alarm")) return "ALARM";

  return "GENERIC";
}

// ==========================
// BUILDERS
// ==========================

function buildLight(input: BuildInput, warnings: string[]): TuyaCommand[] | null {
  const powerFn = findFn(input.functions, ["switch_led", "switch"]);
  if (!powerFn) return null;

  if (input.action === "TURN_ON") {
    return [{ code: powerFn.code, value: true }];
  }

  if (input.action === "TURN_OFF") {
    return [{ code: powerFn.code, value: false }];
  }

  if (input.action === "SET_BRIGHTNESS") {
    const brightFn = findFn(input.functions, ["bright_value_v2", "bright_value"]);
    if (!brightFn) return null;

    const v = asNumber(input.value);
    if (v == null) return null;

    return [{ code: brightFn.code, value: v }];
  }

  warnings.push("LIGHT_UNSUPPORTED_ACTION");
  return null;
}

function buildAC(input: BuildInput, warnings: string[]): TuyaCommand[] | null {
  const powerFn = findFn(input.functions, ["switch"]);
  const tempFn = findFn(input.functions, ["temp_set", "temp"]);

  if (!powerFn) return null;

  if (input.action === "TURN_ON") {
    return [{ code: powerFn.code, value: true }];
  }

  if (input.action === "TURN_OFF") {
    return [{ code: powerFn.code, value: false }];
  }

  if (input.action === "SET_TEMPERATURE") {
    if (!tempFn) return null;

    const v = asNumber(input.value);
    if (v == null) return null;

    return [
      { code: powerFn.code, value: true },
      { code: tempFn.code, value: scaleNumber(v, tempFn) },
    ];
  }

  warnings.push("AC_UNSUPPORTED_ACTION");
  return null;
}

function buildAlarm(input: BuildInput, warnings: string[]): TuyaCommand[] | null {
  const fn = findFn(input.functions, ["master_mode"]);
  if (!fn) return null;

  const meta = parseValues(fn);
  const allowed = meta?.range ?? [];

  function pick(val: string) {
    return allowed.includes(val) ? val : null;
  }

  if (input.action === "DISARM") {
    const v = pick("disarmed") || pick("off");
    if (!v) return null;
    return [{ code: fn.code, value: v }];
  }

  if (input.action === "ARM") {
    const v = pick("arm") || pick("armed");
    if (!v) return null;
    return [{ code: fn.code, value: v }];
  }

  return null;
}

// ==========================
// MAIN
// ==========================

export default function buildTuyaCommands(input: BuildInput): TuyaCommandBuildResult {
  const action = resolveAction(input.action);

  let deviceKind: TuyaDeviceKind =
    normalizeUpper(input.deviceProfile) === "AC_BASIC"
      ? "AC"
      : normalizeUpper(input.deviceProfile) === "LIGHT_BASIC"
      ? "LIGHT"
      : resolveDeviceKind(input.deviceKind);

  if (!action) {
    return {
      ok: false,
      deviceKind,
      action: "TURN_ON",
      commands: [],
      warnings: [],
      error: "UNSUPPORTED_AUTOMATION_ACTION",
    };
  }

  const warnings: string[] = [];
  let commands: TuyaCommand[] | null = null;

  // 🔥 PRIORIDAD REAL: functions primero
  if (findFn(input.functions, ["master_mode"])) {
    deviceKind = "ALARM";
    commands = buildAlarm(input, warnings);
  } else if (findFn(input.functions, ["temp_set", "temp"])) {
    deviceKind = "AC";
    commands = buildAC(input, warnings);
  } else if (findFn(input.functions, ["switch_led", "bright_value"])) {
    deviceKind = "LIGHT";
    commands = buildLight(input, warnings);
  } else {
    commands = buildLight(input, warnings) || buildAC(input, warnings);
  }

  if (!commands) {
    return {
      ok: false,
      deviceKind,
      action,
      commands: [],
      warnings,
      error: "UNSUPPORTED_TUYA_COMMAND_MAPPING",
    };
  }

  return {
    ok: true,
    deviceKind,
    action,
    commands,
    warnings,
  };
}