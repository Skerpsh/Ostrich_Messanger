import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as api from "@/lib/api";
import { getItem, removeItem, setItem } from "@/lib/storage";

const TOKEN_KEY = "ostrich-token";
const USER_KEY = "ostrich-user";
// An OstrichID the user has not confirmed saving yet. Kept on the device
// until then, so it is not lost if the app closes on the screen showing it
// (the server cannot show it again).
const PENDING_OSTRICH_ID_KEY = "ostrich-pending-id";

type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | {
      status: "signedIn";
      token: string;
      user: api.User;
      // Shown until the user confirms they have saved it.
      pendingOstrichId: string | null;
    };

type AuthContextValue = {
  state: AuthState;
  // Message shown on the login screen, e.g. after the session expired.
  notice: string | null;
  signIn: (
    username: string,
    password: string,
    ostrichId: string,
  ) => Promise<void>;
  signUp: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  // Ends all sessions of the user (every device), then signs out here.
  signOutEverywhere: () => Promise<void>;
  // The user has saved their OstrichID: forget it on this device.
  confirmOstrichIdSaved: () => Promise<void>;
  // Replaces the signed-in user, e.g. after a username change.
  updateUser: (user: api.User) => Promise<void>;
  // Runs an authorized request; logs out if the session has expired.
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const clearSession = useCallback(async () => {
    await Promise.all([
      removeItem(TOKEN_KEY),
      removeItem(USER_KEY),
      removeItem(PENDING_OSTRICH_ID_KEY),
    ]);
    setState({ status: "signedOut" });
  }, []);

  // Restore the saved session on startup.
  useEffect(() => {
    (async () => {
      const [token, savedUser, pendingOstrichId] = await Promise.all([
        getItem(TOKEN_KEY),
        getItem(USER_KEY),
        getItem(PENDING_OSTRICH_ID_KEY),
      ]);

      if (!token || !savedUser) {
        setState({ status: "signedOut" });
        return;
      }

      try {
        const user = await api.getMe(token);
        await setItem(USER_KEY, JSON.stringify(user));
        setState({ status: "signedIn", token, user, pendingOstrichId });
      } catch (error) {
        if (error instanceof api.SessionExpiredError) {
          setNotice(error.message);
          await clearSession();
          return;
        }

        // Offline: keep the saved session, requests will retry later.
        setState({
          status: "signedIn",
          token,
          user: JSON.parse(savedUser),
          pendingOstrichId,
        });
      }
    })();
  }, [clearSession]);

  const startSession = async ({ token, user, ostrich_id }: api.AuthResponse) => {
    await Promise.all([
      setItem(TOKEN_KEY, token),
      setItem(USER_KEY, JSON.stringify(user)),
      ostrich_id
        ? setItem(PENDING_OSTRICH_ID_KEY, ostrich_id)
        : removeItem(PENDING_OSTRICH_ID_KEY),
    ]);
    setNotice(null);
    setState({
      status: "signedIn",
      token,
      user,
      pendingOstrichId: ostrich_id ?? null,
    });
  };

  const signIn = async (
    username: string,
    password: string,
    ostrichId: string,
  ) => {
    await startSession(await api.login(username, password, ostrichId));
  };

  const signUp = async (username: string, password: string) => {
    await startSession(await api.register(username, password));
  };

  const signOut = async () => {
    if (state.status === "signedIn") {
      // Best effort: the local session is removed even if offline.
      api.logout(state.token).catch(() => {});
    }

    await clearSession();
  };

  const signOutEverywhere = async () => {
    if (state.status === "signedIn") {
      // Unlike signOut, this must reach the server: other devices stay
      // signed in otherwise.
      await api.logoutAll(state.token);
    }

    await clearSession();
  };

  const confirmOstrichIdSaved = async () => {
    await removeItem(PENDING_OSTRICH_ID_KEY);
    setState((current) =>
      current.status === "signedIn"
        ? { ...current, pendingOstrichId: null }
        : current,
    );
  };

  const updateUser = useCallback(async (user: api.User) => {
    await setItem(USER_KEY, JSON.stringify(user));
    setState((current) =>
      current.status === "signedIn" ? { ...current, user } : current,
    );
  }, []);

  const token = state.status === "signedIn" ? state.token : null;

  const withToken = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      if (!token) {
        throw new api.SessionExpiredError();
      }

      try {
        return await fn(token);
      } catch (error) {
        if (error instanceof api.SessionExpiredError) {
          setNotice(error.message);
          await clearSession();
        }

        throw error;
      }
    },
    [token, clearSession],
  );

  return (
    <AuthContext
      value={{
        state,
        notice,
        signIn,
        signUp,
        signOut,
        signOutEverywhere,
        confirmOstrichIdSaved,
        updateUser,
        withToken,
      }}
    >
      {children}
    </AuthContext>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return context;
}

// The signed-in user, or null (e.g. for the moment between the session
// expiring and the navigator leaving a protected screen).
export function useCurrentUser() {
  const { state } = useAuth();

  return state.status === "signedIn" ? state.user : null;
}
