import { Router } from "express";

export const meRouter = Router();

meRouter.get("/api/me", async (req, res) => {

  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  res.json({
    userId: user.id,
    email: user.email,
    orgId: user.orgId
  });

});