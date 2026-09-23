import { z } from 'zod';

/**
 * Sign-in and password-recovery rules, shared by the web forms and the API
 * routes so the two cannot drift. A form uses them for immediate feedback; the
 * API re-validates with the same schema because client-side rules are a
 * convenience, never a defence.
 */

/**
 * The address rule, reused by sign-in and by "forgot my password" so both paths
 * normalise the address identically - otherwise "reset for Me@Example.com"
 * would fail to find the account that "sign in as me@example.com" can reach.
 */
const emailRule = z
  .string({ required_error: 'Enter your email address.' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address.')
  .email('Enter a valid email address.');

export const loginSchema = z.object({
  email: emailRule,
  password: z.string({ required_error: 'Enter your password.' }).min(1, 'Enter your password.'),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * What a new password has to satisfy.
 *
 * The 72-byte ceiling is not a style preference: bcrypt hashes only the first 72
 * bytes of its input and silently ignores the rest, so a longer password would
 * appear to be accepted while the tail never contributed to the digest. Counting
 * bytes rather than characters matters here - 72 accented characters are more
 * than 72 bytes in UTF-8.
 */
export const passwordRules = z
  .string({ required_error: 'Enter a password.' })
  .min(8, 'Use at least 8 characters.')
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).length > 72) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use at most 72 bytes (about 72 characters).',
      });
    }
  });

export type PasswordInput = z.infer<typeof passwordRules>;

export const forgotPasswordSchema = z.object({
  email: emailRule,
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/**
 * The two values the reset form submits: the single-use token from the emailed
 * link and the chosen password. The token's bounds keep a hostile query string
 * from reaching the lookup with something absurd; the minimum matches the
 * generator's own length so a truncated link fails validation rather than
 * silently missing the stored hash.
 */
export const resetPasswordSchema = z.object({
  token: z
    .string({ required_error: 'This reset link is incomplete.' })
    .trim()
    .min(32, 'This reset link is incomplete.')
    .max(512, 'This reset link is not valid.'),
  password: passwordRules,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
