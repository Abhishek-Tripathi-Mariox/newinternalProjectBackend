import { config } from '../../config/index.js';
import { INVITE_TTL_DAYS, RESET_TTL_HOURS } from '../auth/oneTime.js';

/** Link to the frontend page that consumes a one-time token (/accept-invite or /reset-password). */
export function accountLink(kind, email, token) {
  const q = new URLSearchParams({ email, token });
  return `${config.appUrl}/${kind}?${q}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Simple, client-safe HTML layout (inline styles, table-free single column). */
function layout({ heading, intro, button, link, note }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2330">
<div style="max-width:520px;margin:32px auto;padding:0 16px">
  <div style="font-weight:700;font-size:16px;margin-bottom:16px">${esc(config.mail.from.name)}</div>
  <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e3e5ec">
    <h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 20px">${intro}</p>
    <a href="${esc(link)}" style="display:inline-block;background:#3a4fd8;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">${esc(button)}</a>
    <p style="font-size:12px;line-height:1.6;color:#6b7080;margin:20px 0 0">${esc(note)}<br>If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;color:#3a4fd8">${esc(link)}</span></p>
  </div>
  <p style="font-size:11px;color:#9095a3;margin:16px 0">If you weren't expecting this email, you can ignore it.</p>
</div></body></html>`;
  return html;
}

export function inviteEmail({ name, email, roleName, invitedBy, token }) {
  const link = accountLink('accept-invite', email, token);
  const org = config.mail.from.name;
  const note = `This link works once and expires in ${INVITE_TTL_DAYS} days.`;
  return {
    to: email,
    subject: `You're invited to the ${org} portal`,
    text: `Hi ${name},\n\n${invitedBy} invited you to the ${org} portal${roleName ? ` as ${roleName}` : ''}.\n`
      + `Set your password to activate your account:\n\n${link}\n\n${note}\n`,
    html: layout({
      heading: 'Set up your account',
      intro: `Hi ${esc(name)},<br>${esc(invitedBy)} invited you to the ${esc(org)} portal${roleName ? ` as <b>${esc(roleName)}</b>` : ''}. Choose a password to activate your account.`,
      button: 'Activate account',
      link,
      note,
    }),
    link,
  };
}

export function resetEmail({ name, email, token }) {
  const link = accountLink('reset-password', email, token);
  const org = config.mail.from.name;
  const note = `This link works once and expires in ${RESET_TTL_HOURS} hours.`;
  return {
    to: email,
    subject: `Set a new password for the ${org} portal`,
    text: `Hi ${name},\n\nUse this link to set a new password for your ${org} portal account:\n\n${link}\n\n${note}\n`,
    html: layout({
      heading: 'Set a new password',
      intro: `Hi ${esc(name)},<br>Use the button below to set a new password for your ${esc(org)} portal account.`,
      button: 'Set new password',
      link,
      note,
    }),
    link,
  };
}
