from __future__ import annotations

from pathlib import Path
import re

ROOT = Path.cwd()
POLICY_MODULE = "./guest-journey-tenant-property-scope.policy"


def load(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def save(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    require(count == 1, f"{label}: expected one exact anchor, found {count}")
    return text.replace(old, new, 1)


def regex_once(
    text: str,
    pattern: str,
    replacement: str | callable,
    label: str,
    *,
    flags: int = re.MULTILINE | re.DOTALL,
) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    require(count == 1, f"{label}: expected one regex anchor, found {count}")
    return updated


def insert_policy_import(path: str, names: list[str]) -> None:
    text = load(path)
    require(
        "guest-journey-tenant-property-scope.policy" not in text,
        f"{path}: policy import already present",
    )
    body = "import {\n" + "".join(f"  {name},\n" for name in names) + f'}} from "{POLICY_MODULE}";\n\n'
    save(path, body + text)


def function_bounds(text: str, name: str) -> tuple[int, int]:
    declarations = list(
        re.finditer(
            rf"(?m)^(?:export )?function {re.escape(name)}\(",
            text,
        )
    )
    require(
        len(declarations) == 1,
        f"{name}: expected one function declaration, found {len(declarations)}",
    )
    declaration = declarations[0]
    start = declaration.start()
    open_paren = declaration.end() - 1
    depth = 0
    close_paren = -1
    for index in range(open_paren, len(text)):
        char = text[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                close_paren = index
                break
    require(close_paren >= 0, f"{name}: unmatched parameter list")
    open_brace = text.find("{", close_paren)
    require(open_brace >= 0, f"{name}: body not found")
    depth = 0
    close_brace = -1
    for index in range(open_brace, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                close_brace = index + 1
                break
    require(close_brace > open_brace, f"{name}: unmatched body")
    return start, close_brace


def replace_function(path: str, name: str, replacement: str) -> None:
    text = load(path)
    start, end = function_bounds(text, name)
    save(path, text[:start] + replacement + text[end:])


def remove_function(path: str, name: str) -> None:
    text = load(path)
    start, end = function_bounds(text, name)
    while end < len(text) and text[end] == "\n":
        end += 1
        if end < len(text) and text[end] != "\n":
            break
    save(path, text[:start] + text[end:])


CONFIGS: dict[str, tuple[str, str | None, str | None]] = {
    "src/services/guest-journey-shadow.config.ts": (
        "GUEST_JOURNEY_SHADOW_SCOPE_REQUIRED: enable at least one organization tenant",
        None,
        None,
    ),
    "src/services/guest-journey-internal-reconcile.config.ts": (
        "GUEST_JOURNEY_INTERNAL_RECONCILE_SCOPE_REQUIRED: enable at least one organization tenant",
        None,
        None,
    ),
    "src/services/guest-journey-coordination.config.ts": (
        "GUEST_JOURNEY_COORDINATION_INTENTS_SCOPE_REQUIRED: enable at least one organization tenant",
        None,
        None,
    ),
    "src/services/guest-journey-owner-runtime.config.ts": (
        "GUEST_JOURNEY_OWNER_RUNTIME_SCOPE_REQUIRED: enable at least one organization tenant",
        None,
        None,
    ),
    "src/services/guest-journey-mission-control.config.ts": (
        "GUEST_JOURNEY_MISSION_CONTROL_BRIDGE_SCOPE_REQUIRED: enable at least one organization tenant",
        None,
        None,
    ),
    "src/services/guest-journey-communications-owner.config.ts": (
        "GUEST_JOURNEY_COMMUNICATIONS_SCOPE_REQUIRED: enable at least one organization tenant",
        "isGuestJourneyCommunicationsOwnerScope",
        "GuestJourneyCommunicationsOwnerConfig",
    ),
    "src/services/guest-journey-access-owner.config.ts": (
        "GUEST_JOURNEY_ACCESS_OWNER_SCOPE_REQUIRED: enable at least one organization tenant",
        "isGuestJourneyAccessOwnerScope",
        "GuestJourneyAccessOwnerConfig",
    ),
    "src/services/guest-journey-financial-owner.config.ts": (
        "GUEST_JOURNEY_FINANCIAL_OWNER_SCOPE_REQUIRED: enable at least one organization tenant",
        "isGuestJourneyFinancialOwnerScope",
        "GuestJourneyFinancialOwnerConfig",
    ),
    "src/services/guest-journey-compliance-owner.config.ts": (
        "GUEST_JOURNEY_COMPLIANCE_OWNER_SCOPE_REQUIRED: enable at least one organization tenant",
        "isGuestJourneyComplianceOwnerScope",
        "GuestJourneyComplianceOwnerConfig",
    ),
}

CONFIG_VALIDATION_PATTERN = (
    r'  if \(\s*enabled\s*&&\s*'
    r'organizationIds\.length === 0\s*&&\s*'
    r'propertyIds\.length === 0\s*\) \{\s*'
    r'throw new Error\(\s*"[^"]+"\s*\);\s*\}'
)

for path, (error_code, helper_name, config_type) in CONFIGS.items():
    names = ["assertGuestJourneyTenantPropertyScope"]
    if helper_name:
        names.append("isGuestJourneyTenantPropertyScope")
    insert_policy_import(path, names)
    text = load(path)
    text = regex_once(
        text,
        CONFIG_VALIDATION_PATTERN,
        f'''  assertGuestJourneyTenantPropertyScope({{
    enabled,
    scope: {{
      organizationIds,
      propertyIds,
    }},
    errorCode:
      "{error_code}",
  }});''',
        f"{path}: hierarchical config validation",
    )
    save(path, text)

    if helper_name and config_type:
        replace_function(
            path,
            helper_name,
            f'''export function {helper_name}(
  config: {config_type},
  input: {{
    organizationId?: string | null;
    propertyId?: string | null;
  }}
): boolean {{
  if (!config.enabled) return false;
  return isGuestJourneyTenantPropertyScope(
    config,
    input
  );
}}''',
        )

control_plane = "src/services/guest-journey-activation-control-plane.service.ts"
insert_policy_import(control_plane, ["assertGuestJourneyTenantPropertyScope"])
replace_function(
    control_plane,
    "scopePresent",
    '''function scopePresent(
  config: StageConfig
): boolean {
  return config.organizationIds.length > 0;
}''',
)
text = load(control_plane)
old_scope_gate = '''  if (
    profile !== "off" &&
    !scopePresent({
      enabled: true,
      ...scope,
    })
  ) {
    throw new Error(
      "GUEST_JOURNEY_APMS_ACTIVATION_SCOPE_REQUIRED: enabled profiles require tenant/property scope"
    );
  }
'''
new_scope_gate = '''  assertGuestJourneyTenantPropertyScope({
    enabled: profile !== "off",
    scope,
    errorCode:
      "GUEST_JOURNEY_APMS_ACTIVATION_SCOPE_REQUIRED: enabled profiles require organization tenant scope",
  });
'''
text = replace_once(text, old_scope_gate, new_scope_gate, "control plane organization-rooted scope")
save(control_plane, text)

runtime_enforcement = "src/services/guest-journey-runtime-enforcement.service.ts"
insert_policy_import(runtime_enforcement, ["assertGuestJourneyTenantPropertyScope"])
text = load(runtime_enforcement)
old_runtime_gate = '''  if (
    organizationIds.length === 0 &&
    propertyIds.length === 0
  ) {
    throw new Error(
      "GUEST_JOURNEY_RUNTIME_SCOPE_REQUIRED: enabled activation profiles require tenant/property scope"
    );
  }
'''
new_runtime_gate = '''  assertGuestJourneyTenantPropertyScope({
    enabled: true,
    scope: {
      organizationIds,
      propertyIds,
    },
    errorCode:
      "GUEST_JOURNEY_RUNTIME_ORGANIZATION_SCOPE_REQUIRED: enabled activation profiles require organization tenant scope",
  });
'''
text = replace_once(text, old_runtime_gate, new_runtime_gate, "runtime organization-rooted preflight")
save(runtime_enforcement, text)

CYCLE_VALIDATION_PATTERN = (
    r'  if \(\s*config\.enabled\s*&&\s*'
    r'config\.organizationIds\.length === 0\s*&&\s*'
    r'config\.propertyIds\.length === 0\s*\) \{\s*'
    r'throw new Error\(\s*"(?P<error>[^"]+)"\s*\);\s*\}'
)


def patch_cycle_validation(path: str) -> None:
    text = load(path)

    def replacement(match: re.Match[str]) -> str:
        return f'''  assertGuestJourneyTenantPropertyScope({{
    enabled: config.enabled,
    scope: config,
    errorCode: "{match.group("error")}",
  }});'''

    text = regex_once(
        text,
        CYCLE_VALIDATION_PATTERN,
        replacement,
        f"{path}: hierarchical runtime validation",
    )
    save(path, text)


RESERVATION_CYCLES = [
    "src/services/guest-journey-shadow-cycle.service.ts",
    "src/services/guest-journey-engine-cycle.service.ts",
    "src/services/guest-journey-coordination-cycle.service.ts",
]

for path in RESERVATION_CYCLES:
    insert_policy_import(
        path,
        [
            "assertGuestJourneyTenantPropertyScope",
            "buildGuestJourneyReservationScopeWhere",
        ],
    )
    patch_cycle_validation(path)
    text = load(path)
    start = text.find("  const scopes")
    require(start >= 0, f"{path}: scopes declaration not found")
    end = text.find("\n\n  return {", start)
    require(end > start, f"{path}: scopes block end not found")
    scope_block = text[start:end]
    require(
        "organizationIds" in scope_block and "propertyIds" in scope_block,
        f"{path}: unexpected scopes block",
    )
    text = text[:start] + text[end + 2 :]
    text = regex_once(
        text,
        r'''\{\s*OR:\s*scopes,\s*\},''',
        "buildGuestJourneyReservationScopeWhere(\n        input.config\n      ),",
        f"{path}: reservation hierarchy selector",
    )
    save(path, text)

INTENT_CYCLES = [
    "src/services/guest-journey-owner-runtime-cycle.service.ts",
    "src/services/guest-journey-communications-owner-cycle.service.ts",
    "src/services/guest-journey-access-owner-cycle.service.ts",
    "src/services/guest-journey-financial-owner-cycle.service.ts",
    "src/services/guest-journey-compliance-owner-cycle.service.ts",
]

for path in INTENT_CYCLES:
    insert_policy_import(
        path,
        [
            "assertGuestJourneyTenantPropertyScope",
            "buildGuestJourneyCoordinationIntentScopeWhere",
        ],
    )
    patch_cycle_validation(path)
    text = load(path)
    start = text.find("  const scopeFilters = [")
    require(start >= 0, f"{path}: scopeFilters declaration not found")
    end = text.find("\n  ];", start)
    require(end > start, f"{path}: scopeFilters block end not found")
    scope_block = text[start : end + len("\n  ];")]
    require(
        "organizationIds" in scope_block and "propertyIds" in scope_block,
        f"{path}: unexpected scopeFilters block",
    )
    text = text[:start] + text[end + len("\n  ];") :]
    text = regex_once(
        text,
        r'''\{\s*OR:\s*scopeFilters\s*,?\s*\},''',
        "buildGuestJourneyCoordinationIntentScopeWhere(\n          config\n        ),",
        f"{path}: intent hierarchy selector",
    )
    save(path, text)

mission_cycle = "src/services/guest-journey-mission-control-cycle.service.ts"
insert_policy_import(
    mission_cycle,
    [
        "assertGuestJourneyTenantPropertyScope",
        "buildGuestJourneyCoordinationIntentScopeWhere",
    ],
)
patch_cycle_validation(mission_cycle)
remove_function(mission_cycle, "buildScopeFilters")
text = load(mission_cycle)
text = regex_once(
    text,
    r'''\{\s*OR:\s*buildScopeFilters\(\s*input\.config\s*\),\s*\},''',
    "buildGuestJourneyCoordinationIntentScopeWhere(\n            input.config\n          ),",
    "Mission Control hierarchy selector",
)
save(mission_cycle, text)

CLAIM_FILES = [
    "src/services/guest-journey-owner-runtime.service.ts",
    "src/services/guest-journey-communications-owner-runtime.service.ts",
    "src/services/guest-journey-access-owner-runtime.service.ts",
    "src/services/guest-journey-financial-owner-runtime.service.ts",
    "src/services/guest-journey-compliance-owner-runtime.service.ts",
]

for path in CLAIM_FILES:
    insert_policy_import(path, ["isGuestJourneyTenantPropertyScope"])
    text = load(path)
    start, end = function_bounds(text, "scopeAllows")
    original = text[start:end]
    signature_end = original.find("{")
    require(signature_end >= 0, f"{path}: scopeAllows body missing")
    signature = original[:signature_end]
    replacement = (
        signature
        + '''{
  return isGuestJourneyTenantPropertyScope(
    scope,
    {
      organizationId,
      propertyId,
    }
  );
}'''
    )
    save(path, text[:start] + replacement + text[end:])

for path in [
    "src/services/guest-journey-access-owner.config.test.ts",
    "src/services/guest-journey-financial-owner.config.test.ts",
    "src/services/guest-journey-compliance-owner.config.test.ts",
    "src/services/guest-journey-communications-owner.config.test.ts",
]:
    text = load(path)
    text = replace_once(
        text,
        '    organizationId: "org-1",\n  }), true);',
        '    organizationId: "org-1",\n    propertyId: "property-2",\n  }), true);',
        f"{path}: property subset positive assertion",
    )
    save(path, text)

required_markers = {
    **{
        path: "assertGuestJourneyTenantPropertyScope"
        for path in CONFIGS
    },
    **{
        path: "buildGuestJourneyReservationScopeWhere"
        for path in RESERVATION_CYCLES
    },
    **{
        path: "buildGuestJourneyCoordinationIntentScopeWhere"
        for path in [*INTENT_CYCLES, mission_cycle]
    },
    **{
        path: "isGuestJourneyTenantPropertyScope"
        for path in CLAIM_FILES
    },
}

for path, marker in required_markers.items():
    require(marker in load(path), f"{path}: missing final marker {marker}")

for path in RESERVATION_CYCLES:
    require("OR: scopes" not in load(path), f"{path}: legacy OR scopes remains")
for path in INTENT_CYCLES:
    require("OR: scopeFilters" not in load(path), f"{path}: legacy OR scopeFilters remains")
require("buildScopeFilters" not in load(mission_cycle), "Mission Control legacy scope builder remains")

print("APMS hierarchical tenant/property scope patch applied")
