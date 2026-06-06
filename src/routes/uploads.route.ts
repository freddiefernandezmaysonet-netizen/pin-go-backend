import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { requireAuth } from "../middleware/requireAuth";

export const uploadsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

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

      if (!req.file) {
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

        stream.end(req.file.buffer);
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