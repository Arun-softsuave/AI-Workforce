import fs from "node:fs";
import path from "node:path";
import { serviceRoot } from "../core/paths.js";

/**
 * Static files of the live dashboard (service/web/, module 5.27): index.html, app.js, app.css.
 * Plain files, no build step. The session token is put into the page as <meta name="aiw-token">, so the page needs
 * no inline script and the CSP can forbid inline scripts entirely.
 */

/** CSP for the dashboard page and its files: only our own scripts; inline styles stay allowed for style="" attributes. */
export const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
};

export function webDir(): string {
  return process.env.AIW_WEB_DIR ?? path.join(serviceRoot(), "web");
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The dashboard page with the session token filled in, or undefined when service/web is missing. */
export function webPage(token: string): string | undefined {
  try {
    const html = fs.readFileSync(path.join(webDir(), "index.html"), "utf8");
    return html.replace(/__AIW_TOKEN__/g, escAttr(token));
  } catch { return undefined; }
}

/**
 * One static file under /web/… (no folders above web/, no hidden files, known types only).
 * Returns undefined for anything else, so the caller answers 404.
 */
export function webAsset(urlPath: string): { body: Buffer; type: string } | undefined {
  const rel = decodeURIComponent(urlPath.replace(/^\/web\//, ""));
  if (!rel || rel.includes("..") || rel.includes("\0") || /(^|[\\/])\./.test(rel) || path.isAbsolute(rel)) return undefined;
  const type = TYPES[path.extname(rel).toLowerCase()];
  if (!type || rel.toLowerCase().endsWith(".html")) return undefined;
  const root = path.resolve(webDir());
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return undefined;
  try { return { body: fs.readFileSync(file), type }; } catch { return undefined; }
}

/** Headers for the page and its files. */
export function webHeaders(type: string): Record<string, string> {
  return { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": WEB_CSP };
}
