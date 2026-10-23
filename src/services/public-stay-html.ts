type PublicStay = {
  title: string; bookingPath: string | null; city?: string | null;
  region?: string | null; country?: string | null; maxGuests?: number | null;
  photoUrl?: string | null;
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function renderPublicStayHtml(html: string, stays: PublicStay[]): string {
  const cards = stays.slice(0, 6).filter(p => /^\/book\/[^/?#\\]+\/[^/?#\\]+$/.test(p.bookingPath ?? "")).map(p => {
    const href = escapeHtml("https://pin-ngo.com" + p.bookingPath);
    const title = escapeHtml(p.title);
    const photo = p.photoUrl && /^https:\/\//i.test(p.photoUrl)
      ? `<a href="${href}"><img src="${escapeHtml(p.photoUrl)}" alt="${title}" loading="lazy"></a>` : '<div class="ph"></div>';
    const capacity = Number.isInteger(p.maxGuests) && Number(p.maxGuests) > 0
      ? `<p>Hasta ${p.maxGuests} huéspedes</p>` : "";
    return `<article class="card">${photo}<div class="body"><small>${escapeHtml([p.city, p.region, p.country].filter(Boolean).join(", "))}</small><h3>${title}</h3>${capacity}<a href="${href}">Ver disponibilidad y reservar →</a></div></article>`;
  }).join("");
  return html.replace('<h2 id="featuredTitle"></h2>', '<h2 id="featuredTitle">Estadías destacadas</h2>')
    .replace('<p id="featuredText"></p>', '<p id="featuredText">Una selección de propiedades para descubrir antes de comenzar tu búsqueda.</p>')
    .replace('<div id="featuredCards" class="cards"></div>', () => `<div id="featuredCards" class="cards">${cards}</div>`);
}

// Keep the search page available even if its optional initial catalog is slow.
export async function initialPublicStays<T>(load: () => Promise<T[]>, timeoutMs = 1500): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([load(), new Promise<T[]>(resolve => { timer = setTimeout(() => resolve([]), timeoutMs); })]);
  } catch { return []; }
  finally { if (timer) clearTimeout(timer); }
}
