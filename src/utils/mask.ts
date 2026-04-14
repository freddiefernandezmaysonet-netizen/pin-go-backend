export function maskPasscode(body: string) {
  // Busca números de 4-10 dígitos (ajústalo si quieres)
  return body.replace(/\b\d{4,10}\b/g, (match) => {
    const visible = match.slice(-2);
    return "****" + visible;
  });
}