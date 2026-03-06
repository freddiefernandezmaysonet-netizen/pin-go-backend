import type { Request, Response, NextFunction } from "express";

// Captura raw body para verificación HMAC
export function readRawBodyMiddleware(req: any, _res: Response, next: NextFunction) {
  // Si tu app usa express.json(), lo ideal es configurar "verify" global.
  // Aquí asumimos que req.rawBody ya viene si lo configuraste.
  // Si no, al menos dejamos algo consistente:
  if (!req.rawBody) {
    try {
      // Re-serializa como fallback (no perfecto, pero mejor que nada)
      req.rawBody = Buffer.from(JSON.stringify(req.body ?? {}));
    } catch {
      req.rawBody = Buffer.from("");
    }
  }
  next();
}