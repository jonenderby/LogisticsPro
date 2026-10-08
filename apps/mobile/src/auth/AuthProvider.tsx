import type { Lang } from "@logisticspro/workspace";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { stopBackgroundTracking } from "../state/backgroundLocation";
import { unregisterPush } from "../state/notifications";
import { publicApi, session } from "../api/client";
import { BASE_PATH, IS_WEB } from "../config";

type Phase =
  | { name: "loading" }
  | { name: "signedOut" }
  | { name: "enroll"; token: string; secret: string; otpauthUrl: string }
  | { name: "mfa"; token: string }
  | { name: "recoveryCodes"; codes: string[] }
  | { name: "signedIn" };

interface Enrollment {
  enrollToken: string;
  totpSecret: string;
  otpauthUrl: string;
}
interface SessionResponse {
  accessToken: string;
  /** Absent on web, where the API keeps it in an httpOnly cookie. */
  refreshToken?: string;
}

export type ProfileType = "TRUCKER" | "CARRIER" | "BROKER_3PL" | "BUSINESS";

interface AuthApi {
  phase: Phase;
  /** Changes when a platform admin switches account, so the signed-in app starts over. */
  epoch: number;
  /** Platform admins: use the app as a test account, and come back. */
  switchTo(accountId: string): Promise<void>;
  switchBack(): Promise<void>;
  register(input: { email: string; password: string; name: string; phone?: string; profileType: ProfileType; language: Lang }): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  activate(code: string): Promise<void>;
  verify(code: string): Promise<void>;
  finishRecoveryCodes(): void;
  signOut(): Promise<void>;
  cancel(): void;
}

const Ctx = createContext<AuthApi | undefined>(undefined);

/**
 * Sign-in state machine. Two-factor is mandatory: new accounts enroll an
 * authenticator app before their first session, then save recovery codes.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    session.onSignedOut(() => setPhase({ name: "signedOut" }));
    session.restore().then((ok) => setPhase(ok ? { name: "signedIn" } : { name: "signedOut" }));
  }, []);

  const toEnroll = (e: Enrollment) => setPhase({ name: "enroll", token: e.enrollToken, secret: e.totpSecret, otpauthUrl: e.otpauthUrl });

  const register = useCallback<AuthApi["register"]>(async (input) => {
    toEnroll(await publicApi.post<Enrollment>("/v1/auth/register", input));
  }, []);

  const signIn = useCallback<AuthApi["signIn"]>(async (email, password) => {
    const r = await publicApi.post<{ status: string; mfaToken?: string } & Partial<Enrollment>>("/v1/auth/login", { email, password });
    if (r.status === "MFA_REQUIRED") setPhase({ name: "mfa", token: r.mfaToken! });
    else toEnroll(r as Enrollment);
  }, []);

  const activate = useCallback<AuthApi["activate"]>(
    async (code) => {
      if (phase.name !== "enroll") return;
      const r = await publicApi.post<SessionResponse & { recoveryCodes: string[] }>("/v1/auth/mfa/activate", { token: phase.token, code });
      await session.set(r);
      setPhase({ name: "recoveryCodes", codes: r.recoveryCodes });
    },
    [phase],
  );

  const verify = useCallback<AuthApi["verify"]>(
    async (code) => {
      if (phase.name !== "mfa") return;
      await session.set(await publicApi.post<SessionResponse>("/v1/auth/login/mfa", { token: phase.token, code }));
      setPhase({ name: "signedIn" });
    },
    [phase],
  );

  const switched = useCallback(async (change: () => Promise<void>) => {
    // Tracking and push belong to whoever was signed in before.
    await stopBackgroundTracking();
    await change();
    if (IS_WEB && typeof window !== "undefined") window.history.replaceState(null, "", `${BASE_PATH}/`);
    setEpoch((e) => e + 1);
  }, []);

  const value = useMemo<AuthApi>(
    () => ({
      phase,
      epoch,
      switchTo: (accountId) => switched(() => session.switchTo(accountId)),
      switchBack: () => switched(() => session.switchBack()),
      register,
      signIn,
      activate,
      verify,
      finishRecoveryCodes: () => setPhase({ name: "signedIn" }),
      signOut: async () => {
        await stopBackgroundTracking();
        await unregisterPush();
        await session.clear();
        setPhase({ name: "signedOut" });
      },
      cancel: () => setPhase({ name: "signedOut" }),
    }),
    [phase, epoch, switched, register, signIn, activate, verify],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
