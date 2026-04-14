export type TuyaApiResponse<T = unknown> = {
  success: boolean;
  t: number;
  result?: T;
  code?: string | number;
  msg?: string;
};

export type TuyaProjectTokenResult = {
  access_token: string;
  refresh_token: string;
  expire_time: number;
};

export type TuyaProjectTokenResponse = TuyaApiResponse<TuyaProjectTokenResult>;