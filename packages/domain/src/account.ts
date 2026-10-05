import { z } from "zod";

/** The profile picked at sign-up. It seeds defaults; capabilities come from memberships. */
export const ProfileType = z.enum(["TRUCKER", "CARRIER", "BROKER_3PL", "BUSINESS"]);
export type ProfileType = z.infer<typeof ProfileType>;

export const DriverProfile = z.object({
  cdlNumber: z.string().optional(),
  cdlState: z.string().optional(),
  endorsements: z.array(z.enum(["H", "N", "P", "S", "T", "X"])).default([]),
  twicCard: z.boolean().default(false),
  /** Org that dispatches this driver. An owner-operator points at their own company. */
  homeCarrierOrgId: z.string().optional(),
});
export type DriverProfile = z.infer<typeof DriverProfile>;

export const Account = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string().optional(),
  profileType: ProfileType,
  passwordHash: z.string(),
  mfa: z.object({
    enabled: z.boolean(),
    totpSecret: z.string().optional(),
    recoveryCodeHashes: z.array(z.string()).default([]),
  }),
  driver: DriverProfile.optional(),
  createdAt: z.string(),
});
export type Account = z.infer<typeof Account>;

export type PublicAccount = Omit<Account, "passwordHash" | "mfa"> & { mfaEnabled: boolean };

export function toPublicAccount(a: Account): PublicAccount {
  const { passwordHash: _p, mfa, ...rest } = a;
  return { ...rest, mfaEnabled: mfa.enabled };
}
