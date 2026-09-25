"use client";

import { useEffect, useRef, useState } from "react";
import { useOperator } from "@/components/dashboard/OperatorContext";
import Icon from "@/components/shared/Icon";
import { useT } from "@/lib/languageContext";

type Message = {
  role: "user" | "assistant";
  text: string;
  steps?: Array<{ tool: string; ok: boolean; error?: string }>;
  model?: string;
};

const SUGGESTIONS = ["copilot_suggest_priority", "copilot_suggest_fires", "copilot_suggest_plan"];

export default function OperatorCopilot() {
  const t = useT();
  const { isOperator, operatorFetch } = useOperator();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const next: Message[] = [...messages, { role: "user", text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const result = await operatorFetch<{
        answer: string;
        steps: Array<{ tool: string; ok: boolean; error?: string }>;
        model: string;
      }>("/api/operator/copilot", {
        messages: next.map((message) => ({ role: message.role, text: message.text })),
      });
      setMessages([...next, { role: "assistant", text: result.answer, steps: result.steps, model: result.model }]);
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : String(askError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="svd-card svd-card-full svd-copilot">
      <header className="svd-card-head svd-card-head-split">
        <div>
          <p className="sv-eyebrow">{t("copilot_kicker")}</p>
          <h2 className="vs-title">
            <Icon name="message" size={17} />
            {t("copilot_title")}
          </h2>
          <p>{t("copilot_detail")}</p>
        </div>
        {messages.length > 0 && (
          <button type="button" className="svd-action" onClick={() => setMessages([])} disabled={busy}>
            {t("copilot_clear")}
          </button>
        )}
      </header>

      {!isOperator ? (
        <p className="svd-empty">{t("copilot_signin")}</p>
      ) : (
        <>
          <div className="svd-copilot-log" ref={logRef} aria-live="polite">
            {messages.length === 0 && (
              <ul className="svd-chip-row">
                {SUGGESTIONS.map((key) => (
                  <li key={key}>
                    <button type="button" className="svd-suggestion" onClick={() => void ask(t(key))}>
                      {t(key)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {messages.map((message, index) => (
              <div key={index} className={`svd-msg svd-msg-${message.role}`}>
                <p>{message.text}</p>
                {message.steps && message.steps.length > 0 && (
                  <ul className="svd-chip-row" aria-label={t("copilot_tools_used")}>
                    {message.steps.map((step, stepIndex) => (
                      <li
                        key={`${step.tool}-${stepIndex}`}
                        className={`svd-chip ${step.ok ? "is-ok" : "is-warn"}`}
                        title={step.error}
                      >
                        {t(`copilot_tool_${step.tool}`)}
                      </li>
                    ))}
                  </ul>
                )}
                {message.model && <small>{message.model}</small>}
              </div>
            ))}
            {busy && (
              <div className="svd-msg svd-msg-assistant">
                <p className="svd-typing">{t("copilot_thinking")}</p>
              </div>
            )}
          </div>
          {error && <p className="svd-form-error">{error}</p>}
          <form
            className="svd-copilot-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(input);
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t("copilot_placeholder")}
              aria-label={t("copilot_placeholder")}
              maxLength={1000}
            />
            <button type="submit" className="svd-btn svd-btn-primary" disabled={busy || !input.trim()}>
              {t("copilot_ask")}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
