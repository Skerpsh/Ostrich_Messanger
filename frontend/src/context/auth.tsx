import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as api from "@/lib/api";
import {
  clearChatKeys,
  createAccountKeys,
  deriveFromOstrichId,
  formatOstrichId,
  fromBase64,
  generateOstrichId,
  normalizeOstrichId,
  openPrivateKey,
  toBase64,
} from "@/lib/crypto";
import { getItem, removeItem, setItem } from "@/lib/storage";

const TOKEN_KEY = "ostrich-token";
const USER_KEY = "ostrich-user";
// An OstrichID the user has not confirmed saving yet. Kept on the device
// until then, so it is not lost if the app closes on the screen showing it
// (nobody can show it again).
const PENDING_OSTRICH_ID_KEY = "ostrich-pending-id";
// The account's private key (decrypted), so the device can read messages
// without asking for the OstrichID every time. Removed on logout.
const PRIVATE_KEY_KEY = "ostrich-private-key";

type AuthState =
  | { status: "loading" }
  | { status: "signedOut" }
  | {
      status: "signedIn";
      token: string;
      user: api.User;
      // Shown until the user confirms they have saved it.
      pendingOstrichId: string | null;
      // null: this device has no keys yet (logged in before end-to-end
      // encryption); the OstrichID unlocks them.
      privateKey: Uint8Array | null;
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
  // Gets the account's keys onto this device with the OstrichID.
  unlock: (ostrichId: string) => Promise<void>;
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

const WRONG_ID = "Invalid username, password or OstrichID";

function parseOstrichId(input: string) {
  const id = normalizeOstrichId(input);

  if (!id) {
    throw new api.ApiError(
      "An OstrichID has 20 letters and digits, like XXXX-XXXX-XXXX-XXXX-XXXX",
      400,
    );
  }

  return id;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const clearSession = useCallback(async () => {
    await Promise.all([
      removeItem(TOKEN_KEY),
      removeItem(USER_KEY),
      removeItem(PENDING_OSTRICH_ID_KEY),
      removeItem(PRIVATE_KEY_KEY),
    ]);
    clearChatKeys();
    setState({ status: "signedOut" });
  }, []);

  // Restore the saved session on startup.
  useEffect(() => {
    (async () => {
      const [token, savedUser, pendingOstrichId, savedKey] = await Promise.all([
        getItem(TOKEN_KEY),
        getItem(USER_KEY),
        getItem(PENDING_OSTRICH_ID_KEY),
        getItem(PRIVATE_KEY_KEY),
      ]);

      if (!token || !savedUser) {
        setState({ status: "signedOut" });
        return;
      }

      let privateKey: Uint8Array | null;
      let offlineUser: api.User;

      try {
        privateKey = savedKey ? fromBase64(savedKey) : null;
        offlineUser = JSON.parse(savedUser);
      } catch {
        // Damaged storage: start over rather than hang on the splash screen.
        await clearSession();
        return;
      }

      try {
        const user = await api.getMe(token);
        await setItem(USER_KEY, JSON.stringify(user));
        setState({ status: "signedIn", token, user, pendingOstrichId, privateKey });
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
          user: offlineUser,
          pendingOstrichId,
          privateKey,
        });
      }
    })().catch(() => setState({ status: "signedOut" }));
  }, [clearSession]);

  const startSession = async (
    { token, user }: api.AuthResponse,
    privateKey: Uint8Array,
    pendingOstrichId: string | null,
  ) => {
    await Promise.all([
      setItem(TOKEN_KEY, token),
      setItem(USER_KEY, JSON.stringify(user)),
      setItem(PRIVATE_KEY_KEY, toBase64(privateKey)),
      pendingOstrichId
        ? setItem(PENDING_OSTRICH_ID_KEY, pendingOstrichId)
        : removeItem(PENDING_OSTRICH_ID_KEY),
    ]);
    setNotice(null);
    setState({ status: "signedIn", token, user, pendingOstrichId, privateKey });
  };

  const signIn = async (
    username: string,
    password: string,
    ostrichIdInput: string,
  ) => {
    const ostrichId = parseOstrichId(ostrichIdInput);
    const derived = deriveFromOstrichId(ostrichId);

    let response: api.AuthResponse;

    try {
      response = await api.login(username, password, derived.authKey);
    } catch (error) {
      if (!(error instanceof api.ApiError) || error.code !== "upgrade_required") {
        throw error;
      }

      // An account from before end-to-end encryption: set it up now.
      response = await api.login(username, password, derived.authKey, {
        ostrichId,
        keys: createAccountKeys(derived).material,
      });
    }

    let privateKey: Uint8Array;

    try {
      privateKey = openPrivateKey(derived, response.keys!.encrypted_private_key);
    } catch {
      throw new api.ApiError(WRONG_ID, 401);
    }

    await startSession(response, privateKey, null);
  };

  const signUp = async (username: string, password: string) => {
    const ostrichId = generateOstrichId();
    const { material, privateKey } = createAccountKeys(
      deriveFromOstrichId(ostrichId),
    );

    const response = await api.register(username, password, material);
    await startSession(response, privateKey, formatOstrichId(ostrichId));
  };

  const unlock = async (ostrichIdInput: string) => {
    if (state.status !== "signedIn") {
      return;
    }

    const ostrichId = parseOstrichId(ostrichIdInput);
    const derived = deriveFromOstrichId(ostrichId);
    const token = state.token;

    let keys: api.AccountKeys;

    try {
      keys = await api.getKeys(token);
    } catch (error) {
      if (!(error instanceof api.ApiError) || error.code !== "upgrade_required") {
        throw error;
      }

      keys = await api.upgradeKeys(
        token,
        ostrichId,
        createAccountKeys(derived).material,
      );
    }

    let privateKey: Uint8Array;

    try {
      privateKey = openPrivateKey(derived, keys.encrypted_private_key);
    } catch {
      throw new api.ApiError("Wrong OstrichID", 401);
    }

    await setItem(PRIVATE_KEY_KEY, toBase64(privateKey));
    setState((current) =>
      current.status === "signedIn" ? { ...current, privateKey } : current,
    );
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
        unlock,
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

// The account's private key on this device, or null.
export function usePrivateKey() {
  const { state } = useAuth();

  return state.status === "signedIn" ? state.privateKey : null;
}
