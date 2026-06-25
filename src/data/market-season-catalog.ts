export type MarketSeasonCatalogItem = {
  country: string;
  region: string | null;
  seasons: {
    name: string;
    startMonth: number;
    startDay: number;
    endMonth: number;
    endDay: number;
    adjustmentPercent: number;
  }[];
};

export const MARKET_SEASON_CATALOG: MarketSeasonCatalogItem[] = [
 
{
  country: "United States",
  region: "Puerto Rico",
  seasons: [
    {
      name: "Winter Peak",
      type: "PEAK",
      startMonth: 12,
      startDay: 1,
      endMonth: 4,
      endDay: 30,
      adjustmentPercent: 25,
    },
    {
      name: "Spring Shoulder",
      type: "SHOULDER",
      startMonth: 5,
      startDay: 1,
      endMonth: 6,
      endDay: 30,
      adjustmentPercent: 10,
    },
    {
      name: "Summer Peak",
      type: "PEAK",
      startMonth: 7,
      startDay: 1,
      endMonth: 7,
      endDay: 31,
      adjustmentPercent: 15,
    },
    {
      name: "Late Summer Shoulder",
      type: "SHOULDER",
      startMonth: 8,
      startDay: 1,
      endMonth: 8,
      endDay: 31,
      adjustmentPercent: 5,
    },
    {
      name: "Hurricane / Low Season",
      type: "LOW",
      startMonth: 9,
      startDay: 1,
      endMonth: 11,
      endDay: 30,
      adjustmentPercent: -15,
    },
  ],
},

  {
    country: "United States",
    region: null,
    seasons: [
      {
        name: "Spring Break",
        startMonth: 3,
        startDay: 1,
        endMonth: 4,
        endDay: 15,
        adjustmentPercent: 15,
      },
      {
        name: "Summer Peak",
        startMonth: 6,
        startDay: 1,
        endMonth: 8,
        endDay: 31,
        adjustmentPercent: 20,
      },
      {
        name: "Thanksgiving",
        startMonth: 11,
        startDay: 20,
        endMonth: 11,
        endDay: 30,
        adjustmentPercent: 20,
      },
      {
        name: "Christmas Peak",
        startMonth: 12,
        startDay: 15,
        endMonth: 1,
        endDay: 7,
        adjustmentPercent: 35,
      },
    ],
  },
];