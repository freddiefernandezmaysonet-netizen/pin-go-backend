type AccessMsgArgs = {
  roomName: string;
  code: string;      // ej: 7026343#
  unlockKeyHint?: string; // ej: "#"
  start: Date;
  end: Date;
  brand?: string; // Pin&Go
};

function fmtPR(d: Date) {
  // formato simple: DD-MM-YYYY HH:mm (24h)
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildAccessMessage({ roomName, code, unlockKeyHint = "#", start, end, brand = "Pin&Go" }: AccessMsgArgs) {
  const startFmt = fmtPR(start);
  const endFmt = fmtPR(end);

  const es = `🔐 ${brand} Access • ${roomName}

Tu código de acceso es: ${code}
(La tecla ${unlockKeyHint} es la tecla de DESBLOQUEO en el keypad. Puede ser ${unlockKeyHint}, *, u otro símbolo según el modelo.)

Válido en este periodo:
Desde ${startFmt}
Hasta ${endFmt}

— ${brand}`;

  const en = `🔐 ${brand} Access • ${roomName}

Your access code is: ${code}
(The ${unlockKeyHint} key is the UNLOCK key on the keypad. It may be ${unlockKeyHint}, *, or another symbol depending on the model.)

Valid during:
From ${startFmt}
To ${endFmt}

— ${brand}`;
// Enviar por WhatsApp (español por default)
if (phone) {
   sendWhatsApp(phone, es);
}

  return { es, en };
}
