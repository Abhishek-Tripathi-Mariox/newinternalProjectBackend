import { z } from 'zod';

const email = z.string().trim().max(254);
const password = z.string().min(8, 'Use at least 8 characters.').max(128);

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const refreshSchema = z.object({ refreshToken: z.string().max(200).optional() });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const acceptInviteSchema = z.object({ email, token: z.string().min(10).max(200), password });
export const resetPasswordSchema = z.object({ email, token: z.string().min(10).max(200), password });
