import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { shortAddress, STATUS_LABEL, type HealthReport } from "@qorewatch/core";

/** The fonts ship with the bot (assets/fonts), so cards look the same on any server. */
function fontDir(): string {
  const candidates = [fileURLToPath(new URL("../../assets/fonts", import.meta.url)), fileURLToPath(new URL("../assets/fonts", import.meta.url)), join(process.cwd(), "assets/fonts")];
  return candidates.find((d) => existsSync(join(d, "Figtree_400Regular.ttf"))) ?? candidates[0]!;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COLOR = { ready: "#34d3b4", attention: "#ffb547", at_risk: "#ff6b6b", unused: "#8b94a5" } as const;

/** QoreWatch's mark: a watchful eye inside a rounded shield. */
export function markSvg(x: number, y: number, size: number, color = "#34d3b4"): string {
  const s = size / 64;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M32 3 L56 12 V30 C56 45 46 56 32 61 C18 56 8 45 8 30 V12 Z" fill="none" stroke="${color}" stroke-width="3.2" stroke-linejoin="round"/>
    <path d="M16 32 C21 24 26 21 32 21 C38 21 43 24 48 32 C43 40 38 43 32 43 C26 43 21 40 16 32 Z" fill="none" stroke="#e8eef3" stroke-width="3"/>
    <circle cx="32" cy="32" r="5.5" fill="${color}"/>
  </g>`;
}

/** Render a check report as a 1200×630 PNG share card. */
export function renderCard(r: HealthReport, opts: { handle?: string; botUsername: string }): Uint8Array {
  const c = COLOR[r.status];
  const pct = r.status === "unused" ? 0 : r.score / 100;
  const R = 120;
  const circ = 2 * Math.PI * R;
  const lines = r.findings
    .filter((f) => f.severity !== "info" || f.id === "no_pop")
    .slice(0, 4)
    .map((f) => ({ icon: f.severity === "good" ? "#34d3b4" : f.severity === "critical" ? "#ff6b6b" : f.severity === "warning" ? "#ffb547" : "#7aa7ff", text: f.title.replace(/<[^>]+>/g, "") }));
  const date = new Date(r.checkedAt).toISOString().slice(0, 10);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g1" cx="0.82" cy="0.18" r="0.7"><stop offset="0" stop-color="${c}" stop-opacity="0.20"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="0.05" cy="1" r="0.6"><stop offset="0" stop-color="#3b82f6" stop-opacity="0.10"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></radialGradient>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#ffffff" fill-opacity="0.05"/></pattern>
  </defs>
  <rect width="1200" height="630" fill="#070b0f"/>
  <rect width="1200" height="630" fill="url(#dots)"/>
  <rect width="1200" height="630" fill="url(#g1)"/>
  <rect width="1200" height="630" fill="url(#g2)"/>
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  ${markSvg(64, 58, 52)}
  <text x="128" y="94" font-family="Gabarito" font-weight="700" font-size="34" fill="#e8eef3">QoreWatch</text>
  <text x="64" y="176" font-family="Figtree" font-weight="600" font-size="24" fill="#8b94a5" letter-spacing="3">POST-QUANTUM ACCOUNT CHECK</text>
  <text x="64" y="236" font-family="DM Mono" font-weight="500" font-size="34" fill="#e8eef3">${esc(shortAddress(r.address, 14, 8))}</text>
  ${opts.handle ? `<text x="64" y="278" font-family="Figtree" font-weight="600" font-size="26" fill="${c}">@${esc(opts.handle)}</text>` : ""}
  <rect x="64" y="${opts.handle ? 306 : 270}" width="${36 + STATUS_LABEL[r.status].length * 15}" height="52" rx="26" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-opacity="0.6"/>
  <circle cx="92" cy="${opts.handle ? 332 : 296}" r="7" fill="${c}"/>
  <text x="110" y="${opts.handle ? 341 : 305}" font-family="Figtree" font-weight="600" font-size="24" fill="${c}">${esc(STATUS_LABEL[r.status])}</text>
  ${lines
    .map((l, i) => {
      const y = (opts.handle ? 404 : 368) + i * 44;
      return `<circle cx="74" cy="${y - 8}" r="6" fill="${l.icon}"/><text x="94" y="${y}" font-family="Figtree" font-weight="400" font-size="24" fill="#c9d1db">${esc(l.text.slice(0, 54))}</text>`;
    })
    .join("\n  ")}
  <circle cx="930" cy="300" r="${R}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="22"/>
  <circle cx="930" cy="300" r="${R}" fill="none" stroke="${c}" stroke-width="22" stroke-linecap="round" stroke-dasharray="${(circ * pct).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 930 300)"/>
  <text x="930" y="322" text-anchor="middle" font-family="Gabarito" font-weight="700" font-size="${r.status === "unused" ? 44 : 84}" fill="#e8eef3">${r.status === "unused" ? "n/a" : r.score}</text>
  <text x="930" y="362" text-anchor="middle" font-family="Figtree" font-weight="600" font-size="22" fill="#8b94a5">out of 100</text>
  <text x="64" y="566" font-family="Figtree" font-weight="400" font-size="22" fill="#6b7686">QoreChain testnet · checked ${date}</text>
  <text x="1136" y="566" text-anchor="end" font-family="DM Mono" font-weight="500" font-size="22" fill="#8b94a5">t.me/${esc(opts.botUsername)}</text>
</svg>`;
  const dir = fontDir();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: {
      loadSystemFonts: false,
      fontFiles: ["Gabarito_700Bold.ttf", "Figtree_400Regular.ttf", "Figtree_600SemiBold.ttf", "DMMono_500Medium.ttf"].map((f) => join(dir, f)),
      defaultFontFamily: "Figtree",
    },
  });
  return resvg.render().asPng();
}
