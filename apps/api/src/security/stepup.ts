import type { AppContext } from "../http.js";
import { totpStep } from "./totp.js";

/**
 * Accept an authenticator code once (RFC 6238 section 5.2): a code seen on
 * the wire, or reused within its 30 seconds, is refused. Used at sign-in and
 * again for sensitive changes such as where a carrier gets paid.
 */
export function acceptTotpCode(ctx: AppContext, accountId: string, secret: string | undefined, code: string): boolean {
  if (!secret) return false;
  const step = totpStep(secret, code, ctx.now().getTime());
  if (step === undefined || step <= (ctx.store.totpLastStep.get(accountId) ?? -1)) return false;
  ctx.store.totpLastStep.set(accountId, step);
  return true;
}
