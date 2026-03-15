authRouter.post("/api/auth/register-organization", async (req, res) => {
  try {
    const organizationName = String(req.body?.organizationName ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const fullName = String(req.body?.name ?? "").trim();
    const role =
      String(req.body?.role ?? "ADMIN").trim().toUpperCase() === "MEMBER"
        ? "MEMBER"
        : "ADMIN";

    if (!organizationName || !email || !password || !fullName) {
      return res.status(400).json({
        ok: false,
        error: "ORGANIZATION_NAME_EMAIL_PASSWORD_NAME_REQUIRED",
      });
    }

    const existingUser = await prisma.dashboardUser.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        error: "EMAIL_ALREADY_REGISTERED",
      });
    }

    const passwordHash = await require("bcryptjs").hash(password, 10);

    const created = await prisma.organization.create({
      data: {
        name: organizationName,
        dashboardUsers: {
          create: {
            email,
            passwordHash,
            fullName,
            role,
            isActive: true,
          },
        },
      },
      include: {
        dashboardUsers: {
          select: {
            id: true,
            organizationId: true,
            email: true,
            fullName: true,
            role: true,
            isActive: true,
          },
        },
      },
    });

    const createdUser = created.dashboardUsers[0];

    return res.status(201).json({
      ok: true,
      organization: {
        id: created.id,
        name: created.name,
      },
      user: {
        id: createdUser.id,
        email: createdUser.email,
        fullName: createdUser.fullName,
        orgId: createdUser.organizationId,
        role: createdUser.role,
      },
    });
  } catch (e: any) {
    console.error("[auth/register-organization] ERROR", e);
    return res.status(500).json({
      ok: false,
      error: e?.message ?? "REGISTER_ORGANIZATION_FAILED",
    });
  }
});