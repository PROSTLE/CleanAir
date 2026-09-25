"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

type OperatorStatus = "loading" | "unavailable" | "signed_out" | "checking" | "not_operator" | "operator";

type OperatorContextValue = {
  status: OperatorStatus;
  email: string | null;
  error: string | null;
  isOperator: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** POST JSON with the operator's Firebase ID token; throws with the server's message. */
  operatorFetch: <T>(url: string, body?: unknown) => Promise<T>;
};

const OperatorContext = createContext<OperatorContextValue | null>(null);

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? `Request failed (${response.status}).`;
}

export function OperatorProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<OperatorStatus>(auth ? "loading" : "unavailable");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setStatus("signed_out");
        return;
      }
      // The server is the authority on who is an operator.
      setStatus("checking");
      try {
        const token = await nextUser.getIdToken();
        const response = await fetch("/api/operator/me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          setStatus("operator");
          setError(null);
        } else {
          setStatus("not_operator");
          setError(await readError(response));
        }
      } catch (checkError) {
        setStatus("not_operator");
        setError(checkError instanceof Error ? checkError.message : "Could not verify operator access.");
      }
    });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!auth) throw new Error("Firebase is not configured.");
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (signInError) {
      const code = (signInError as { code?: string }).code ?? "";
      const message =
        code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found"
          ? "Email or password is incorrect."
          : code === "auth/too-many-requests"
            ? "Too many attempts. Try again in a few minutes."
            : "Sign-in failed. Check your connection and try again.";
      setError(message);
      throw new Error(message);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (auth) await firebaseSignOut(auth);
  }, []);

  const operatorFetch = useCallback(
    async <T,>(url: string, body?: unknown): Promise<T> => {
      if (!user) throw new Error("Sign in as an operator first.");
      const token = await user.getIdToken();
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as T;
    },
    [user],
  );

  const value = useMemo<OperatorContextValue>(
    () => ({
      status,
      email: user?.email ?? null,
      error,
      isOperator: status === "operator",
      signIn,
      signOut,
      operatorFetch,
    }),
    [status, user, error, signIn, signOut, operatorFetch],
  );

  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>;
}

export function useOperator() {
  const value = useContext(OperatorContext);
  if (!value) throw new Error("useOperator must be used inside <OperatorProvider>.");
  return value;
}
