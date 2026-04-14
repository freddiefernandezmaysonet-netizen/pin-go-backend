import { PrismaClient } from "@prisma/client";
import { tuyaRequest } from "../integrations/tuya/tuya.http";
import { getValidTuyaAccessToken } from "../integrations/tuya/tuya.auth";
import type { TuyaApiResponse } from "../integrations/tuya/tuya.types";

const prisma = new PrismaClient();

export type TuyaUserDevice = {
  id: string;
  name: string;
  category?: string;
  product_id?: string;
  product_name?: string;
  sub?: boolean;
  uuid?: string;
  online?: boolean;
  icon?: string;
  time_zone?: string;
  active_time?: number;
  create_time?: number;
  update_time?: number;
};

export type TuyaAssignedInfo = {
  propertyId: string;
  propertyName: string;
};

export type TuyaOrgDevice = TuyaUserDevice & {
  isAssigned: boolean;
  assignment: TuyaAssignedInfo | null;
};

export async function getTuyaUserDevicesByOrg(
  organizationId: string
): Promise<TuyaApiResponse<TuyaOrgDevice[]>> {
  const orgId = String(organizationId ?? "").trim();

  if (!orgId) {
    throw new Error("ORGANIZATION_ID_REQUIRED");
  }

  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      tuyaUid: true,
    },
  });

  if (!organization) {
    throw new Error("ORGANIZATION_NOT_FOUND");
  }

  const integration = await prisma.integrationAccount.findUnique({
    where: {
      organizationId_provider: {
        organizationId: orgId,
        provider: "TUYA",
      },
    },
    select: {
      status: true,
      externalUid: true,
    },
  });

  const linkedUid = String(
    organization.tuyaUid ?? integration?.externalUid ?? ""
  ).trim();

  const isLinked =
    linkedUid.length > 0 &&
    (integration == null || integration.status === "LINKED");

  if (!isLinked) {
    throw new Error("TUYA_NOT_LINKED");
  }

  const accessToken = await getValidTuyaAccessToken();

  console.log("[tuya] requesting org devices", {
    organizationId: orgId,
    uid: linkedUid,
    hasAccessToken: Boolean(accessToken),
  });

  const resp = await tuyaRequest<TuyaUserDevice[]>({
    method: "GET",
    path: `/v1.0/users/${linkedUid}/devices`,
    accessToken,
  });

  const rawDevices = Array.isArray(resp.result) ? resp.result : [];
  const externalIds = rawDevices
    .map((d) => String(d?.id ?? "").trim())
    .filter((id) => id.length > 0);

  const assignedRows =
    externalIds.length === 0
      ? []
      : await prisma.propertyAutomationDevice.findMany({
          where: {
            organizationId: orgId,
            provider: "TUYA",
            externalDeviceId: { in: externalIds },
          },
          select: {
            externalDeviceId: true,
            propertyId: true,
            property: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

  const assignedMap = new Map<string, TuyaAssignedInfo>();
  for (const row of assignedRows) {
    const externalDeviceId = String(row.externalDeviceId ?? "").trim();
    if (!externalDeviceId) continue;

    assignedMap.set(externalDeviceId, {
      propertyId: row.propertyId,
      propertyName: row.property?.name ?? "Property",
    });
  }

  const enrichedDevices: TuyaOrgDevice[] = rawDevices.map((device) => {
    const externalDeviceId = String(device?.id ?? "").trim();
    const assignment = assignedMap.get(externalDeviceId) ?? null;

    return {
      ...device,
      isAssigned: Boolean(assignment),
      assignment,
    };
  });

  console.log("[tuya] org devices response", {
    organizationId: orgId,
    uid: linkedUid,
    success: resp.success,
    code: resp.code,
    msg: resp.msg,
    count: enrichedDevices.length,
    assignedCount: enrichedDevices.filter((d) => d.isAssigned).length,
  });

  return {
    ...resp,
    result: enrichedDevices,
  };
}