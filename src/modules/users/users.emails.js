import { config } from '../../config/index.js';
import { esc, layout } from '../../core/emailLayout.js';
import { INVITE_TTL_DAYS, RESET_TTL_HOURS } from '../auth/oneTime.js';

/** Link to the frontend page that consumes a one-time token (/accept-invite or /reset-password). */
export function accountLink(kind, email, token) {
  const q = new URLSearchParams({ email, token });
  return `${config.appUrl}/${kind}?${q}`;
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
