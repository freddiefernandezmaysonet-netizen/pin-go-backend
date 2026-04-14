import React from "react";

export type GuestExperienceDevice = {
  id: string;
  name: string;
  category?: string | null;
  online?: boolean;
};

export type DeviceExperienceConfig = {
  enabled: boolean;
  checkInAction: "NONE" | "TURN_ON" | "SET_COMFORT" | "DISARM";
  checkOutAction: "NONE" | "TURN_OFF" | "ARM";
  temperature?: number;
  brightness?: number;
  mode?: "cool" | "heat" | "auto";
};

export type DeviceExperienceMap = Record<string, DeviceExperienceConfig>;

export type GuestExperiencePreset =
  | "WELCOME"
  | "COMFORT"
  | "ENERGY_SAVER"
  | "LIGHTS_ONLY";

type Props = {
  enabled: boolean;
  saving?: boolean;
  devices: GuestExperienceDevice[];
  value: DeviceExperienceMap;
  onEnabledChange: (value: boolean) => void;
  onChange: (deviceId: string, patch: Partial<DeviceExperienceConfig>) => void;
  onApplyPreset: (preset: GuestExperiencePreset) => void;
  onSave: () => void;
};

function sectionTitle(text: string) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 800,
        color: "#374151",
        marginBottom: 8,
      }}
    >
      {text}
    </div>
  );
}

function cardStyle(disabled?: boolean): React.CSSProperties {
  return {
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 14,
    background: disabled ? "#f9fafb" : "#fff",
    opacity: disabled ? 0.7 : 1,
    display: "grid",
    gap: 10,
  };
}

function badge(label: string, tone: "neutral" | "success" | "warning") {
  const styles =
    tone === "success"
      ? {
          background: "#ecfdf5",
          color: "#065f46",
          border: "1px solid #a7f3d0",
        }
      : tone === "warning"
      ? {
          background: "#fffbeb",
          color: "#92400e",
          border: "1px solid #fcd34d",
        }
      : {
          background: "#f3f4f6",
          color: "#4b5563",
          border: "1px solid #e5e7eb",
        };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        ...styles,
      }}
    >
      {label}
    </span>
  );
}

function normalizeCategory(value?: string | null) {
  const raw = String(value ?? "").trim().toLowerCase();

  if (!raw) return "generic";

  if (
    raw.includes("air") ||
    raw.includes("ac") ||
    raw.includes("climate") ||
    raw.includes("hvac") ||
    raw.includes("infrared_ac")
  ) {
    return "ac";
  }

  if (
    raw.includes("light") ||
    raw.includes("lamp") ||
    raw.includes("bulb") ||
    raw.includes("led") ||
    raw.includes("dj") ||
    raw.includes("rgb") ||
    raw.includes("strip")
  ) {
    return "light";
  }

  if (raw.includes("curtain") || raw.includes("blind")) {
    return "curtain";
  }

  if (raw.includes("switch") || raw.includes("plug") || raw.includes("cz")) {
    return "switch";
  }

  if (
    raw.includes("alarm") ||
    raw.includes("security") ||
    raw.includes("pir") ||
    raw.includes("siren") ||
    raw.includes("mal")
  ) {
    return "alarm";
  }

  return "generic";
}

function categoryLabel(value?: string | null) {
  const normalized = normalizeCategory(value);

  if (normalized === "ac") return "Air Conditioner";
  if (normalized === "light") return "Light";
  if (normalized === "curtain") return "Curtain";
  if (normalized === "switch") return "Switch";
  if (normalized === "alarm") return "Alarm";
  return "Smart Device";
}

function getDefaultConfig(category?: string | null): DeviceExperienceConfig {
  const normalized = normalizeCategory(category);

  if (normalized === "ac") {
    return {
      enabled: true,
      checkInAction: "SET_COMFORT",
      checkOutAction: "TURN_OFF",
      temperature: 72,
      mode: "cool",
    };
  }

  if (normalized === "light") {
    return {
      enabled: true,
      checkInAction: "TURN_ON",
      checkOutAction: "TURN_OFF",
      brightness: 80,
    };
  }

  if (normalized === "alarm") {
    return {
      enabled: true,
      checkInAction: "DISARM",
      checkOutAction: "ARM",
    };
  }

  return {
    enabled: true,
    checkInAction: "TURN_ON",
    checkOutAction: "TURN_OFF",
  };
}

function sanitizeConfig(
  categoryValue: string | null | undefined,
  config?: Partial<DeviceExperienceConfig>
): DeviceExperienceConfig {
  const category = normalizeCategory(categoryValue);
  const base = getDefaultConfig(categoryValue);

  const next: DeviceExperienceConfig = {
    ...base,
    ...(config ?? {}),
  };

  if (category === "alarm") {
    const rawCheckIn = String(next.checkInAction ?? "").toUpperCase();
    const rawCheckOut = String(next.checkOutAction ?? "").toUpperCase();

    next.checkInAction =
      rawCheckIn === "DISARM"
        ? "DISARM"
        : rawCheckIn === "NONE"
        ? "NONE"
        : "DISARM";

    next.checkOutAction =
      rawCheckOut === "ARM"
        ? "ARM"
        : rawCheckOut === "NONE"
        ? "NONE"
        : "ARM";

    delete next.temperature;
    delete next.brightness;
    delete next.mode;
  }

  if (category === "light") {
    delete next.temperature;
    delete next.mode;
  }

  if (category === "ac") {
    delete next.brightness;
  }

  return next;
}

function numberInputStyle(): React.CSSProperties {
  return {
    height: 38,
    borderRadius: 10,
    border: "1px solid #d1d5db",
    padding: "0 10px",
    background: "#fff",
    width: "100%",
  };
}

function selectStyle(): React.CSSProperties {
  return {
    height: 38,
    borderRadius: 10,
    border: "1px solid #d1d5db",
    padding: "0 10px",
    background: "#fff",
    width: "100%",
  };
}

function PresetButton({
  label,
  description,
  selected,
  onClick,
}: {
  label: string;
  description: string;
  selected?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = React.useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: selected
          ? "1px solid #111827"
          : hover
          ? "1px solid #9ca3af"
          : "1px solid #e5e7eb",
        background: selected
          ? "#111827"
          : hover
          ? "#f3f4f6"
          : "#fff",
        borderRadius: 14,
        padding: 16,
        textAlign: "left",
        cursor: "pointer",
        display: "grid",
        gap: 6,
        transform: hover ? "translateY(-2px)" : "translateY(0)",
        boxShadow: hover
          ? "0 6px 18px rgba(0,0,0,0.08)"
          : "0 0 0 rgba(0,0,0,0)",
        transition: "all 0.15s ease",
      }}
    >
      <div
        style={{
          fontWeight: 800,
          color: selected ? "#fff" : "#111827",
          fontSize: 15,
        }}
      >
        {label}
      </div>

      <div
        style={{
          color: selected ? "#e5e7eb" : "#6b7280",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {description}
      </div>
    </button>
  );
}

export function GuestExperienceCard({
  enabled,
  saving,
  devices,
  value,
  onEnabledChange,
  onChange,
  onApplyPreset,
  onSave,
}: Props) {
  const selectedCount = devices.length;
  const [selectedPreset, setSelectedPreset] = React.useState<GuestExperiencePreset | null>(null);

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 18,
        padding: 18,
        background: "#fff",
        display: "grid",
        gap: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>
            Guest Experience
          </div>
          <div style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
            Define the comfort experience that guests receive automatically at check-in and check-out.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {enabled ? badge("Enabled", "success") : badge("Disabled", "neutral")}
          {selectedCount > 0 ? badge(`${selectedCount} device${selectedCount === 1 ? "" : "s"}`, "warning") : null}
          {selectedPreset ? badge(`Preset: ${selectedPreset.replaceAll("_", " ")}`, "neutral") : null}
        </div>
      </div>

      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          fontSize: 14,
          fontWeight: 700,
          color: "#111827",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        Enable guest experience automation
      </label>

      {!enabled ? (
        <div
          style={{
            borderRadius: 12,
            padding: 14,
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            color: "#6b7280",
            fontSize: 14,
          }}
        >
          Guest experience is currently disabled for this property.
        </div>
      ) : null}

      {enabled ? (
        <>
          <div style={{ display: "grid", gap: 10 }}>
            {sectionTitle("Presets")}

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <PresetButton
                label="Welcome"
                description="Turn on lights and prepare the property for arrival."
                selected={selectedPreset === "WELCOME"}
                onClick={() => {
                  setSelectedPreset("WELCOME");
                  onApplyPreset("WELCOME");
                }}
              />

              <PresetButton
                label="Comfort Arrival"
                description="Prepare AC in comfort mode and activate lights for check-in."
                selected={selectedPreset === "COMFORT"}
                onClick={() => {
                  setSelectedPreset("COMFORT");
                  onApplyPreset("COMFORT");
                }}
              />

              <PresetButton
                label="Energy Saver"
                description="Keep arrival minimal and make sure everything turns off at check-out."
                selected={selectedPreset === "ENERGY_SAVER"}
                onClick={() => {
                  setSelectedPreset("ENERGY_SAVER");
                  onApplyPreset("ENERGY_SAVER");
                }}
              />

              <PresetButton
                label="Lights Only"
                description="Use lighting automation only, without climate adjustments."
                selected={selectedPreset === "LIGHTS_ONLY"}
                onClick={() => {
                  setSelectedPreset("LIGHTS_ONLY");
                  onApplyPreset("LIGHTS_ONLY");
                }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {sectionTitle("Per-device experience")}

            {devices.length === 0 ? (
              <div
                style={{
                  borderRadius: 12,
                  padding: 14,
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  color: "#6b7280",
                  fontSize: 14,
                }}
              >
                Select Tuya devices in Automation Setup first. Then configure the guest experience for each selected device here.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {devices.map((device) => {
                  const category = normalizeCategory(device.category);
                  const config = sanitizeConfig(
                    device.category,
                    value[device.id] ?? getDefaultConfig(device.category)
                  );

                  return (
                    <div key={device.id} style={cardStyle(!config.enabled)}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          alignItems: "flex-start",
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontWeight: 800, color: "#111827" }}>
                            {device.name || "Unnamed device"}
                          </div>
                          <div style={{ fontSize: 12, color: "#6b7280" }}>
                            {categoryLabel(device.category)}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {device.online === true
                            ? badge("Online", "success")
                            : badge("Offline", "neutral")}
                          <label
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: 12,
                              color: "#374151",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={config.enabled}
                              onChange={(e) =>
                                onChange(
                                  device.id,
                                  sanitizeConfig(device.category, {
                                    ...config,
                                    enabled: e.target.checked,
                                  })
                                )
                              }
                            />
                            Active
                          </label>
                        </div>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gap: 12,
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                        }}
                      >
                        <div style={{ display: "grid", gap: 6 }}>
                          <label style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                            Check-in action
                          </label>
                          <select
                            value={config.checkInAction}
                            disabled={!config.enabled}
                            onChange={(e) =>
                              onChange(
                                device.id,
                                sanitizeConfig(device.category, {
                                  ...config,
                                  checkInAction: e.target.value as DeviceExperienceConfig["checkInAction"],
                                })
                              )
                            }
                            style={selectStyle()}
                          >
                            <option value="NONE">Do nothing</option>
                            {category === "alarm" ? (
                              <option value="DISARM">Disarm</option>
                            ) : (
                              <>
                                <option value="TURN_ON">Turn on</option>
                                {category === "ac" ? (
                                  <option value="SET_COMFORT">Set comfort mode</option>
                                ) : null}
                              </>
                            )}
                          </select>
                        </div>

                        <div style={{ display: "grid", gap: 6 }}>
                          <label style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                            Check-out action
                          </label>
                          <select
                            value={config.checkOutAction}
                            disabled={!config.enabled}
                            onChange={(e) =>
                              onChange(
                                device.id,
                                sanitizeConfig(device.category, {
                                  ...config,
                                  checkOutAction: e.target.value as DeviceExperienceConfig["checkOutAction"],
                                })
                              )
                            }
                            style={selectStyle()}
                          >
                            <option value="NONE">Do nothing</option>
                            {category === "alarm" ? (
                              <option value="ARM">Arm</option>
                            ) : (
                              <option value="TURN_OFF">Turn off</option>
                            )}
                          </select>
                        </div>

                        {category === "ac" ? (
                          <>
                            <div style={{ display: "grid", gap: 6 }}>
                              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                                Temperature
                              </label>
                              <input
                                type="number"
                                min={60}
                                max={80}
                                value={config.temperature ?? 72}
                                disabled={!config.enabled}
                                onChange={(e) =>
                                  onChange(
                                    device.id,
                                    sanitizeConfig(device.category, {
                                      ...config,
                                      temperature: Number(e.target.value),
                                    })
                                  )
                                }
                                style={numberInputStyle()}
                              />
                            </div>

                            <div style={{ display: "grid", gap: 6 }}>
                              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                                Mode
                              </label>
                              <select
                                value={config.mode ?? "cool"}
                                disabled={!config.enabled}
                                onChange={(e) =>
                                  onChange(
                                    device.id,
                                    sanitizeConfig(device.category, {
                                      ...config,
                                      mode: e.target.value as DeviceExperienceConfig["mode"],
                                    })
                                  )
                                }
                                style={selectStyle()}
                              >
                                <option value="cool">Cool</option>
                                <option value="heat">Heat</option>
                                <option value="auto">Auto</option>
                              </select>
                            </div>
                          </>
                        ) : null}

                        {category === "light" ? (
                          <div style={{ display: "grid", gap: 6 }}>
                            <label style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
                              Brightness %
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={100}
                              value={config.brightness ?? 80}
                              disabled={!config.enabled}
                              onChange={(e) =>
                                onChange(
                                  device.id,
                                  sanitizeConfig(device.category, {
                                    ...config,
                                    brightness: Number(e.target.value),
                                  })
                                )
                              }
                              style={numberInputStyle()}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={onSave}
              disabled={saving}
              style={{
                height: 42,
                padding: "0 16px",
                borderRadius: 12,
                border: "1px solid #111827",
                background: saving ? "#9ca3af" : "#111827",
                color: "#fff",
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving..." : "Save Guest Experience"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default GuestExperienceCard;