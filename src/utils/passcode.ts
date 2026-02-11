export function phoneTo7DigitPasscode(phone?: string | null): string | null {
  if (!phone) return null;

  const digits = String(phone).replace(/\D/g, "");

  // Si vienen 7 exactos
  if (digits.length === 7) return digits;

  // Si vienen más (E164 o 10 dígitos), usa los últimos 7
  if (digits.length > 7) return digits.slice(-7);

  // Menos de 7 -> no sirve
  return null;
}

export function generate7DigitPasscode(): string {
  // 7 dígitos, evitando empezar con 0 por estética
  const first = Math.floor(Math.random() * 9) + 1; // 1..9
  let rest = "";
  for (let i = 0; i < 6; i++) rest += Math.floor(Math.random() * 10);
  return `${first}${rest}`;
}

export function maskPasscode7(code: string): string {
  // 7 dígitos => 5***7
  if (!code) return "***";
  return `${code.slice(0, 1)}***${code.slice(-1)}`;
}
