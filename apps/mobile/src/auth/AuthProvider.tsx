import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { stopBackgroundTracking } from "../state/backgroundLocation";
import { unregisterPush } from "../state/notifications";
import { publicApi, session } from "../api/client";

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
  register(input: { email: string; password: string; name: string; phone?: string; profileType: ProfileType }): Promise<void>;
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

  const value = useMemo<AuthApi>(
    () => ({
      phase,
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
    [phase, register, signIn, activate, verify],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
