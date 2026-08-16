import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import test from "node:test";
import { v2 as cloudinary } from "cloudinary";
import express, { type RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { uploadsRouter } from "./uploads.route.js";

type TestUser = {
  id: string;
  orgId: string;
  role: string;
};

type MutablePrisma = {
  dashboardUser: {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
};

type CloudinaryUploadCallback = (
  error?: unknown,
  result?: Record<string, unknown>
) => void;

type MutableCloudinary = {
  config: (...args: unknown[]) => unknown;
  uploader: {
    upload_stream: (
      options: Record<string, unknown>,
      callback: CloudinaryUploadCallback
    ) => Writable;
  };
};

const mutablePrisma = prisma as unknown as MutablePrisma;
const mutableCloudinary = cloudinary as unknown as MutableCloudinary;

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

async function requestRoute(
  path: string,
  init: RequestInit,
  user?: TestUser
): Promise<Response> {
  const app = express();

  if (user) {
    const injectUser: RequestHandler = (req, _res, next) => {
      (req as typeof req & { user: TestUser }).user = user;
      next();
    };
    app.use(injectUser);
  }

  app.use(uploadsRouter);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        Connection: "close",
        ...(init.headers ?? {}),
      },
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await closeServer(server);
  }
}

function platformAdmin(): TestUser {
  return {
    id: "platform-admin-a",
    orgId: "pin-go-organization",
    role: "PLATFORM_ADMIN",
  };
}

function fileForm(input: {
  bytes: Uint8Array;
  type: string;
  filename: string;
}) {
  const form = new FormData();
  const blobBuffer = new ArrayBuffer(input.bytes.byteLength);
  new Uint8Array(blobBuffer).set(input.bytes);
  form.append(
    "asset",
    new Blob([blobBuffer], { type: input.type }),
    input.filename
  );
  return form;
}

async function withDashboardUserStub<T>(
  findUnique: MutablePrisma["dashboardUser"]["findUnique"],
  action: () => Promise<T>
): Promise<T> {
  const originalFindUnique = mutablePrisma.dashboardUser.findUnique;
  mutablePrisma.dashboardUser.findUnique = findUnique;
  try {
    return await action();
  } finally {
    mutablePrisma.dashboardUser.findUnique = originalFindUnique;
  }
}

async function withCloudinaryStub<T>(
  input: {
    uploadStream: MutableCloudinary["uploader"]["upload_stream"];
    onConfig?: (input: unknown) => void;
  },
  action: () => Promise<T>
): Promise<T> {
  const originalConfig = mutableCloudinary.config;
  const originalUploadStream = mutableCloudinary.uploader.upload_stream;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalApiKey = process.env.CLOUDINARY_API_KEY;
  const originalApiSecret = process.env.CLOUDINARY_API_SECRET;

  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  mutableCloudinary.config = (config) => {
    input.onConfig?.(config);
    return config;
  };
  mutableCloudinary.uploader.upload_stream = input.uploadStream;

  try {
    return await action();
  } finally {
    mutableCloudinary.config = originalConfig;
    mutableCloudinary.uploader.upload_stream = originalUploadStream;

    if (originalCloudName === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
    }
    if (originalApiKey === undefined) {
      delete process.env.CLOUDINARY_API_KEY;
    } else {
      process.env.CLOUDINARY_API_KEY = originalApiKey;
    }
    if (originalApiSecret === undefined) {
      delete process.env.CLOUDINARY_API_SECRET;
    } else {
      process.env.CLOUDINARY_API_SECRET = originalApiSecret;
    }
  }
}

function unusedUploadStream(): Writable {
  throw new Error("Cloudinary must not be called");
}

test("unauthenticated brand asset upload is rejected before file parsing", async () => {
  const response = await requestRoute(
    "/api/internal/admin/branding/assets/logo",
    { method: "POST" }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("organization admin cannot upload brand assets", async () => {
  let databaseReads = 0;

  await withDashboardUserStub(
    async () => {
      databaseReads += 1;
      return null;
    },
    async () => {
      const response = await requestRoute(
        "/api/internal/admin/branding/assets/logo",
        { method: "POST" },
        {
          id: "org-admin-a",
          orgId: "organization-a",
          role: "ORG_ADMIN",
        }
      );

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "PLATFORM_ADMIN_REQUIRED",
      });
    }
  );

  assert.equal(databaseReads, 0);
});

test("inactive PLATFORM_ADMIN cannot upload brand assets", async () => {
  await withDashboardUserStub(
    async () => ({ role: "PLATFORM_ADMIN", isActive: false }),
    async () => {
      const response = await requestRoute(
        "/api/internal/admin/branding/assets/logo",
        { method: "POST" },
        platformAdmin()
      );

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "PLATFORM_ADMIN_REQUIRED",
      });
    }
  );
});

test("active PLATFORM_ADMIN receives controlled input errors", async () => {
  await withDashboardUserStub(
    async () => ({ role: "PLATFORM_ADMIN", isActive: true }),
    async () => {
      const invalidKind = await requestRoute(
        "/api/internal/admin/branding/assets/banner",
        { method: "POST" },
        platformAdmin()
      );
      assert.equal(invalidKind.status, 400);
      assert.deepEqual(await invalidKind.json(), {
        ok: false,
        error: "BRAND_ASSET_KIND_INVALID",
      });

      await withCloudinaryStub(
        { uploadStream: unusedUploadStream },
        async () => {
          const missingFile = await requestRoute(
            "/api/internal/admin/branding/assets/logo",
            { method: "POST" },
            platformAdmin()
          );
          assert.equal(missingFile.status, 400);
          assert.deepEqual(await missingFile.json(), {
            ok: false,
            error: "BRAND_ASSET_FILE_REQUIRED",
          });
        }
      );
    }
  );
});

test("brand asset upload rejects unsupported formats and JPEG favicons", async () => {
  await withDashboardUserStub(
    async () => ({ role: "PLATFORM_ADMIN", isActive: true }),
    async () => {
      const textResponse = await requestRoute(
        "/api/internal/admin/branding/assets/logo",
        {
          method: "POST",
          body: fileForm({
            bytes: new Uint8Array([1, 2, 3]),
            type: "text/plain",
            filename: "logo.txt",
          }),
        },
        platformAdmin()
      );
      assert.equal(textResponse.status, 400);
      assert.deepEqual(await textResponse.json(), {
        ok: false,
        error: "BRAND_ASSET_FILE_INVALID",
      });

      const faviconResponse = await requestRoute(
        "/api/internal/admin/branding/assets/favicon",
        {
          method: "POST",
          body: fileForm({
            bytes: new Uint8Array([0xff, 0xd8, 0xff]),
            type: "image/jpeg",
            filename: "favicon.jpg",
          }),
        },
        platformAdmin()
      );
      assert.equal(faviconResponse.status, 400);
      assert.deepEqual(await faviconResponse.json(), {
        ok: false,
        error: "BRAND_ASSET_FILE_INVALID",
      });
    }
  );
});

test("brand asset upload enforces the two megabyte limit", async () => {
  await withDashboardUserStub(
    async () => ({ role: "PLATFORM_ADMIN", isActive: true }),
    async () => {
      const response = await requestRoute(
        "/api/internal/admin/branding/assets/logo",
        {
          method: "POST",
          body: fileForm({
            bytes: new Uint8Array(2 * 1024 * 1024 + 1),
            type: "image/png",
            filename: "oversized-logo.png",
          }),
        },
        platformAdmin()
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "BRAND_ASSET_FILE_TOO_LARGE",
      });
    }
  );
});

test("active PLATFORM_ADMIN receives safe Cloudinary asset identity", async () => {
  const uploadCapture: { options?: Record<string, unknown> } = {};
  let configuredWith: unknown;
  let receivedBytes = 0;

  await withDashboardUserStub(
    async () => ({ role: "PLATFORM_ADMIN", isActive: true }),
    async () => {
      await withCloudinaryStub(
        {
          onConfig: (input) => {
            configuredWith = input;
          },
          uploadStream: (options, callback) => {
            uploadCapture.options = options;
            const stream = new Writable({
              write(chunk, _encoding, done) {
                receivedBytes += (chunk as Buffer).length;
                done();
              },
            });
            stream.on("finish", () => {
              callback(undefined, {
                secure_url:
                  "https://res.cloudinary.com/test/image/upload/logo.png",
                public_id: "pingo/brand-assets/logo/asset-a",
                width: 600,
                height: 240,
                format: "png",
                bytes: 4,
              });
            });
            return stream;
          },
        },
        async () => {
          const response = await requestRoute(
            "/api/internal/admin/branding/assets/logo",
            {
              method: "POST",
              body: fileForm({
                bytes: new Uint8Array([137, 80, 78, 71]),
                type: "image/png",
                filename: "logo.png",
              }),
            },
            platformAdmin()
          );

          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            ok: true,
            data: {
              kind: "logo",
              url: "https://res.cloudinary.com/test/image/upload/logo.png",
              publicId: "pingo/brand-assets/logo/asset-a",
              width: 600,
              height: 240,
              format: "png",
              bytes: 4,
            },
          });
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
      );
    }
  );

  assert.equal(receivedBytes, 4);
  assert.equal(uploadCapture.options?.folder, "pingo/brand-assets/logo");
  assert.equal(uploadCapture.options?.resource_type, "image");
  assert.deepEqual(configuredWith, {
    cloud_name: "test-cloud",
    api_key: "test-key",
    api_secret: "test-secret",
  });
});
