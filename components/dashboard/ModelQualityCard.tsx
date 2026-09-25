"use client";

import { useEffect, useState } from "react";
import Icon from "@/components/shared/Icon";
import { useT } from "@/lib/languageContext";
import type { Incident } from "@/lib/types";

type ClassifierEval = {
  generatedAt: string;
  model: string;
  total: number;
  binary: { precision: number | null; recall: number | null; f1: number | null; accuracy: number; tp: number; fp: number; tn: number; fn: number };
  errors: number;
};

function pct(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * Two honest quality signals:
 *  1. Operator-verified precision — share of closed incidents operators
 *     confirmed (vs. marked false positive). Real outcomes, not a benchmark.
 *  2. Offline classifier evaluation — produced by `npm run eval:classifier`
 *     on a labelled photo set; shown only if that file exists.
 */
export default function ModelQualityCard({ incidents }: { incidents: Incident[] }) {
  const t = useT();
  const [evaluation, setEvaluation] = useState<ClassifierEval | null | "missing">(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/eval/classifier-eval.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : "missing"))
      .then((data) => {
        if (!cancelled) setEvaluation(data);
      })
      .catch(() => {
        if (!cancelled) setEvaluation("missing");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const confirmed = incidents.filter((incident) => incident.outcome === "confirmed").length;
  const falsePositives = incidents.filter((incident) => incident.outcome === "false_positive").length;
  const judged = confirmed + falsePositives;

  return (
    <section className="svd-card svd-card-wide">
      <header className="svd-card-head">
        <h2 className="vs-title">
          <Icon name="shield" size={17} />
          {t("quality_title")}
        </h2>
        <p>{t("quality_detail")}</p>
      </header>
      <ul className="svd-readings">
        <li>
          <span>{t("quality_operator_precision")}</span>
          <strong>
            {judged === 0 ? "—" : pct(confirmed / judged)}
            <em>{t("quality_n").replace("{n}", String(judged))}</em>
          </strong>
        </li>
        <li>
          <span>{t("quality_confirmed_fp")}</span>
          <strong>{judged === 0 ? "—" : `${confirmed} / ${falsePositives}`}</strong>
        </li>
        {evaluation && evaluation !== "missing" ? (
          <>
            <li>
              <span>{t("quality_eval_precision_recall")}</span>
              <strong>
                {pct(evaluation.binary.precision)} / {pct(evaluation.binary.recall)}
                <em>{t("quality_n").replace("{n}", String(evaluation.total))}</em>
              </strong>
            </li>
            <li>
              <span>{t("quality_eval_f1")}</span>
              <strong>{pct(evaluation.binary.f1)}</strong>
            </li>
          </>
        ) : (
          <li>
            <span>{t("quality_eval_title")}</span>
            <strong>—</strong>
          </li>
        )}
      </ul>
      <p className="svd-note">
        {evaluation && evaluation !== "missing"
          ? t("quality_eval_meta")
              .replace("{model}", evaluation.model)
              .replace("{date}", new Date(evaluation.generatedAt).toLocaleDateString("en-IN"))
          : t("quality_eval_missing")}
      </p>
    </section>
  );
}
