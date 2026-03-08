router.get("/metrics", async (req, res) => {
  const now = new Date()

  const startOfDay = new Date(now)
  startOfDay.setHours(0,0,0,0)

  const endOfDay = new Date(now)
  endOfDay.setHours(23,59,59,999)

  const arrivalsToday = await prisma.reservation.count({
    where: {
      checkIn: {
        gte: startOfDay,
        lte: endOfDay
      }
    }
  })

  const checkoutsToday = await prisma.reservation.count({
    where: {
      checkOut: {
        gte: startOfDay,
        lte: endOfDay
      }
    }
  })

  const guestsInHouse = await prisma.reservation.count({
    where: {
      checkIn: { lte: now },
      checkOut: { gte: now },
      status: "ACTIVE"
    }
  })

  const locksActive = await prisma.lock.count({
    where: { isActive: true }
  })

  const properties = await prisma.property.count()

  res.json({
    arrivalsToday,
    checkoutsToday,
    guestsInHouse,
    locksActive,
    properties
  })
});