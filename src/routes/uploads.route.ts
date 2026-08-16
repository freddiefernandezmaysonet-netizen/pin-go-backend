import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const uploadsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

const BRAND_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const brandAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    const kind = String(req.params.kind ?? "").trim().toLowerCase();
    const validKind = kind === "logo" || kind === "favicon";
    const validMimeType = BRAND_ASSET_MIME_TYPES.has(file.mimetype);
    const validFaviconType =
      kind !== "favicon" ||
      file.mimetype === "image/png" ||
      file.mimetype === "image/webp";

    if (!validKind || !validMimeType || !validFaviconType) {
      callback(new Error("BRAND_ASSET_FILE_INVALID"));
      return;
    }

    callback(null, true);
  },
});

type AuthenticatedUploadRequest = Request & {
  user?: {
    id?: string;
    role?: string;
  };
};

function brandAssetSecurityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}

function requireBrandAssetKind(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const kind = String(req.params.kind ?? "").trim().toLowerCase();
  if (kind !== "logo" && kind !== "favicon") {
    res.status(400).json({
      ok: false,
      error: "BRAND_ASSET_KIND_INVALID",
    });
    return;
  }
  next();
}

async function requireActivePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user = (req as AuthenticatedUploadRequest).user;
  const userId = String(user?.id ?? "").trim();

  if (!userId || user?.role !== "PLATFORM_ADMIN") {
    res.status(403).json({
      ok: false,
      error: "PLATFORM_ADMIN_REQUIRED",
    });
    return;
  }

  try {
    const manager = await prisma.dashboardUser.findUnique({
      where: { id: userId },
      select: { role: true, isActive: true },
    });

    if (!manager?.isActive || manager.role !== "PLATFORM_ADMIN") {
      res.status(403).json({
        ok: false,
        error: "PLATFORM_ADMIN_REQUIRED",
      });
      return;
    }

    next();
  } catch (error) {
    console.error("[ADMIN_BRAND_ASSET_AUTH_ERROR]", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    res.status(500).json({
      ok: false,
      error: "BRAND_ASSET_UPLOAD_FAILED",
    });
  }
}

const receiveBrandAsset: RequestHandler = (req, res, next) => {
  brandAssetUpload.single("asset")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    const code =
      error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
        ? "BRAND_ASSET_FILE_TOO_LARGE"
        : "BRAND_ASSET_FILE_INVALID";
    res.status(400).json({ ok: false, error: code });
  });
};

function brandAssetTransformation(kind: "logo" | "favicon") {
  if (kind === "favicon") {
    return [
      {
        width: 512,
        height: 512,
        crop: "pad",
        background: "transparent",
        quality: "auto:good",
      },
    ];
  }

  return [
    {
      width: 1200,
      height: 600,
      crop: "limit",
      quality: "auto:good",
    },
  ];
}

uploadsRouter.post(
  "/api/internal/admin/branding/assets/:kind",
  brandAssetSecurityHeaders,
  requireAuth,
  requireActivePlatformAdmin,
  requireBrandAssetKind,
  receiveBrandAsset,
  async (req, res) => {
    const kind = String(req.params.kind ?? "").trim().toLowerCase() as
      | "logo"
      | "favicon";

    try {
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      const apiKey = process.env.CLOUDINARY_API_KEY;
      const apiSecret = process.env.CLOUDINARY_API_SECRET;

      if (!cloudName || !apiKey || !apiSecret) {
        res.status(500).json({
          ok: false,
          error: "BRAND_ASSET_UPLOAD_UNAVAILABLE",
        });
        return;
      }

      const assetBuffer = req.file?.buffer;

      if (!assetBuffer?.length) {
        res.status(400).json({
          ok: false,
          error: "BRAND_ASSET_FILE_REQUIRED",
        });
        return;
      }

      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
      });

      const result = await new Promise<{
        secure_url: string;
        public_id: string;
        width: number;
        height: number;
        format: string;
        bytes: number;
      }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `pingo/brand-assets/${kind}`,
            resource_type: "image",
            transformation: brandAssetTransformation(kind),
            overwrite: false,
            unique_filename: true,
          },
          (error, uploadResult) => {
            if (error || !uploadResult) {
              reject(error || new Error("Brand asset upload failed"));
              return;
            }

            resolve({
              secure_url: uploadResult.secure_url,
              public_id: uploadResult.public_id,
              width: uploadResult.width,
              height: uploadResult.height,
              format: uploadResult.format,
              bytes: uploadResult.bytes,
            });
          }
        );

        stream.end(assetBuffer);
      });

      res.json({
        ok: true,
        data: {
          kind,
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        },
      });
    } catch (error) {
      console.error("[ADMIN_BRAND_ASSET_UPLOAD_ERROR]", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(500).json({
        ok: false,
        error: "BRAND_ASSET_UPLOAD_FAILED",
      });
    }
  }
);

uploadsRouter.post(
  "/api/uploads/property-photo",
  requireAuth,
  upload.single("photo"),
  async (req, res) => {
    try {
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      const apiKey = process.env.CLOUDINARY_API_KEY;
      const apiSecret = process.env.CLOUDINARY_API_SECRET;

      if (!cloudName || !apiKey || !apiSecret) {
        return res.status(500).json({
          ok: false,
          error: "Cloudinary environment variables are not configured",
        });
      }

      const photoBuffer = req.file?.buffer;

      if (!photoBuffer) {
        return res.status(400).json({
          ok: false,
          error: "Missing photo file",
        });
      }

      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
      });

      const result = await new Promise<any>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "pingo/property-photos",
            resource_type: "image",
            transformation: [
              {
                width: 1600,
                height: 1000,
                crop: "limit",
                quality: "auto",
                fetch_format: "auto",
              },
            ],
          },
          (error, result) => {
            if (error || !result) {
              reject(error || new Error("Cloudinary upload failed"));
              return;
            }

            resolve(result);
          }
        );

        stream.end(photoBuffer);
      });

      return res.json({
        ok: true,
        url: result.secure_url,
      });
    } catch (error: any) {
      console.error("POST /api/uploads/property-photo error", error);

      return res.status(500).json({
        ok: false,
        error: error?.message ?? "Failed to upload property photo",
      });
    }
  }
);
