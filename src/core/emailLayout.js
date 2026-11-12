import { config } from '../config/index.js';

/** HTML-escape a value for email templates. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Simple, client-safe HTML email layout (inline styles, single column).
 * `intro` and `body` are trusted HTML (escape values before passing them); `button` + `link` are optional.
 */
export function layout({ heading, intro, body = '', button, link, note, footer = "If you weren't expecting this email, you can ignore it." }) {
  const cta = button && link
    ? `<a href="${esc(link)}" style="display:inline-block;background:#3a4fd8;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">${esc(button)}</a>`
    : '';
  const tail = link
    ? `${esc(note)}<br>If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;color:#3a4fd8">${esc(link)}</span>`
    : esc(note);
  return `<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2330">
<div style="max-width:560px;margin:32px auto;padding:0 16px">
  <div style="font-weight:700;font-size:16px;margin-bottom:16px">${esc(config.mail.from.name)}</div>
  <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e3e5ec">
    <h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 20px">${intro}</p>
    ${body}
    ${cta}
    ${tail ? `<p style="font-size:12px;line-height:1.6;color:#6b7080;margin:20px 0 0">${tail}</p>` : ''}
  </div>
  ${footer ? `<p style="font-size:11px;color:#9095a3;margin:16px 0">${esc(footer)}</p>` : ''}
</div></body></html>`;
}
