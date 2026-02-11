import axios from "axios";

export class TTLockClient {
  private baseUrl = process.env.TTLOCK_API_BASE ?? "https://api.sciener.com";

  constructor(private accessToken: string) {}

  private withBaseParams(extra: Record<string, any>) {
    return {
      clientId: process.env.TTLOCK_CLIENT_ID,
      accessToken: this.accessToken,
      date: Date.now(), // ✅ requerido por TTLock
      ...extra,
    };
  }

  async createCustomPasscode(params: {
    lockId: number;
    passcode: string;
    startDate: number;
    endDate: number;
    addType?: number; // 1 bluetooth, 2 gateway
  }) {
    return axios.post(`${this.baseUrl}/v3/keyboardPwd/add`, null, {
      params: this.withBaseParams({
        lockId: params.lockId,
        keyboardPwd: params.passcode,
        startDate: params.startDate,
        endDate: params.endDate,
        addType: params.addType ?? 2,
      }),
    });
  }

  async deletePasscode(params: { lockId: number; keyboardPwdId: number }) {
    return axios.post(`${this.baseUrl}/v3/keyboardPwd/delete`, null, {
      params: this.withBaseParams({
        lockId: params.lockId,
        keyboardPwdId: params.keyboardPwdId,
      }),
    });
  }

  // Nota: endpoint exacto puede variar según tu implementación previa.
  // Si tú ya usabas /v3/card/changePeriod o /v3/identityCard/changePeriod,
  // aquí lo centralizamos.
  async changeCardPeriod(params: {
    lockId: number;
    cardId: number;
    startDate: number;
    endDate: number;
  }) {
    return axios.post(`${this.baseUrl}/v3/card/changePeriod`, null, {
      params: this.withBaseParams({
        lockId: params.lockId,
        cardId: params.cardId,
        startDate: params.startDate,
        endDate: params.endDate,
      }),
    });
  }
}
