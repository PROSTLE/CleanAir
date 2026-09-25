"use client";

import { useEffect, useRef, useState } from "react";
import { useOperator } from "@/components/dashboard/OperatorContext";
import { useT } from "@/lib/languageContext";

export default function OperatorAuth() {
  const t = useT();
  const { status, email, error, signIn, signOut } = useOperator();
  const [open, setOpen] = useState(false);
  const [formEmail, setFormEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    emailRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (status === "unavailable") return null;

  if (status === "loading" || status === "checking") {
    return (
      <div className="svd-auth">
        <span className="svd-chip">{t("op_auth_checking")}</span>
      </div>
    );
  }

  if (status === "operator" || status === "not_operator") {
    return (
      <div className="svd-auth">
        <span className={`svd-chip ${status === "operator" ? "is-ok" : "is-warn"}`} title={error ?? undefined}>
          {status === "operator" ? t("op_auth_operator") : t("op_auth_not_operator")}
        </span>
        <span className="svd-auth-email">{email}</span>
        <button type="button" className="svd-action" onClick={() => void signOut()}>
          {t("op_auth_sign_out")}
        </button>
      </div>
    );
  }

  return (
    <div className="svd-auth">
      <button type="button" className="svd-btn svd-btn-primary" onClick={() => setOpen(true)}>
        {t("op_auth_sign_in")}
      </button>

      {open && (
        <div className="svd-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <form
            className="svd-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="operator-signin-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={async (event) => {
              event.preventDefault();
              setSubmitting(true);
              try {
                await signIn(formEmail, password);
                setPassword("");
                setOpen(false);
              } catch {
                /* message surfaces via context error */
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <p className="sv-eyebrow">{t("op_auth_kicker")}</p>
            <h2 id="operator-signin-title">{t("op_auth_title")}</h2>
            <p className="svd-modal-lede">{t("op_auth_lede")}</p>
            <label className="svd-field">
              <span>{t("op_auth_email")}</span>
              <input
                ref={emailRef}
                type="email"
                autoComplete="username"
                required
                value={formEmail}
                onChange={(event) => setFormEmail(event.target.value)}
              />
            </label>
            <label className="svd-field">
              <span>{t("op_auth_password")}</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error && <p className="svd-form-error" role="alert">{error}</p>}
            <div className="svd-modal-actions">
              <button type="button" className="svd-action" onClick={() => setOpen(false)}>
                {t("common_cancel")}
              </button>
              <button type="submit" className="svd-btn svd-btn-primary" disabled={submitting}>
                {submitting ? t("op_auth_signing_in") : t("op_auth_sign_in")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
