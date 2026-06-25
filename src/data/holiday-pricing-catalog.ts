export const HOLIDAY_PRICING_CATALOG = [
  {
    country: "United States",
    region: "Puerto Rico",
    holidays: [
      {
        name: "Christmas / New Year",
        startMonth: 12,
        startDay: 20,
        endMonth: 1,
        endDay: 6,
        adjustmentPercent: 30,
      },
      {
        name: "Thanksgiving Week",
        startMonth: 11,
        startDay: 20,
        endMonth: 11,
        endDay: 30,
        adjustmentPercent: 20,
      },
      {
        name: "Semana Santa",
        startMonth: 3,
        startDay: 24,
        endMonth: 4,
        endDay: 7,
        adjustmentPercent: 25,
      },
      {
        name: "Independence Day Week",
        startMonth: 7,
        startDay: 1,
        endMonth: 7,
        endDay: 7,
        adjustmentPercent: 15,
      },
    ],
  },
] as const;