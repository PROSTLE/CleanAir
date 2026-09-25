"use client";

import { useEffect, useRef, useState } from "react";
import { getIncidentAge, getRecommendedAction, getRecommendedActionKey } from "@/components/command/commandData";
import { useOperator } from "@/components/dashboard/OperatorContext";
import Icon, { HAZARD_ICON } from "@/components/shared/Icon";
import { compassLabel } from "@/lib/geo";
import { useT } from "@/lib/languageContext";
import { TIER_LABELS } from "@/lib/supportEvidence";
import type { Incident, WorkOrder } from "@/lib/types";

export type DrawerTarget = { incident: Incident; collection: "incidents" | "reports" };

type Piece<T> =
  | { status: "ok"; data: T }
  | { status: "not_configured"; reason: string }
  | { status: "error"; reason: string };

type RankedSource = {
  name: string;
  kind: string;
  distanceKm: number;
  bearingDeg: number;
  offWindDeg: number | null;
  score: number;
};

type FieldContext = {
  fetchedAt: string;
  wind: Piece<{ windSpeedMs: number; windDegrees: number; fetchedAt: string }>;
  attribution: Piece<{
    mode: "upwind" | "calm" | "no_wind";
    wind: { fromDeg: number; speedMs: number } | null;
    sources: RankedSource[];
    regionalUpwindFires: number;
  }>;
  fires: Piece<{ count: number; nearestKm: number | null; radiusKm: number }>;
  sensitiveSites: Piece<Array<{ name: string; kind: "school" | "hospital"; distanceKm: number; address: string | null }>>;
  googleAirQuality: Piece<{
    universalAqi: number | null;
    universalCategory: string | null;
    indiaAqi: number | null;
    indiaCategory: string | null;
    dominantPollutant: string | null;
    pm25: number | null;
    time: string | null;
  }>;
};

type ActionResult = {
  action: string;
  linkedReports: number;
  notification: { sent: number; failed: number; noContact: number; configured: boolean } | { error: string } | null;
};

function PieceNote({ piece }: { piece: { status: string; reason?: string } }) {
  if (piece.status === "ok") return null;
  return <p className="svd-muted-note">{piece.reason}</p>;
}

export default function IncidentDrawer({
  target,
  onClose,
  onToast,
}: {
  target: DrawerTarget;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const { isOperator, operatorFetch } = useOperator();
  const { incident, collection } = target;
  const docId = incident.id.replace(/^firestore-/, "");
  const evidence = incident.evidence;
  const panelRef = useRef<HTMLElement>(null);

  const [context, setContext] = useState<FieldContext | null>(null);
  const [contextState, setContextState] = useState<"idle" | "loading" | "error">("idle");
  const [contextError, setContextError] = useState<string | null>(null);
  const [workOrder, setWorkOrder] = useState<WorkOrder | null>(incident.workOrder ?? null);
  const [workOrderState, setWorkOrderState] = useState<"idle" | "loading" | "error">("idle");
  const [workOrderError, setWorkOrderError] = useState<string | null>(null);
  const [language, setLanguage] = useState<"en" | "hi">("en");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"resolve" | "false_positive" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadContext = async () => {
    setContextState("loading");
    setContextError(null);
    try {
      const result = await operatorFetch<{ context: FieldContext }>("/api/operator/context", { collection, id: docId });
      setContext(result.context);
      setContextState("idle");
    } catch (error) {
      setContextState("error");
      setContextError(error instanceof Error ? error.message : String(error));
    }
  };

  const draftWorkOrder = async () => {
    setWorkOrderState("loading");
    setWorkOrderError(null);
    try {
      const result = await operatorFetch<{ workOrder: WorkOrder }>("/api/operator/work-order", { collection, id: docId });
      setWorkOrder(result.workOrder);
      setWorkOrderState("idle");
    } catch (error) {
      setWorkOrderState("error");
      setWorkOrderError(error instanceof Error ? error.message : String(error));
    }
  };

  const runAction = async (action: "dispatch" | "resolve" | "false_positive") => {
    setPendingAction(action);
    setActionError(null);
    try {
      const result = await operatorFetch<ActionResult>("/api/operator/action", { collection, id: docId, action });
      const notification = result.notification;
      const notified =
        notification && "sent" in notification && notification.sent > 0
          ? ` · ${t("drawer_notified").replace("{count}", String(notification.sent))}`
          : "";
      onToast(`${t(`drawer_done_${action}`)}${notified}`);
      setConfirming(null);
      if (action !== "dispatch") onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  };

  const recommendedAction = t(getRecommendedActionKey(incident)) || getRecommendedAction(incident);
  const sensor = evidence?.sensor;
  const satellite = evidence?.satellite;
  const fusion = evidence?.fusion;
  const tierLabel = evidence?.tier ? t(`tier_${evidence.tier}`) || TIER_LABELS[evidence.tier] : t("drawer_unpromoted");
  const notes = [incident.note, ...(incident.citizenNotes ?? [])]
    .map((note) => note?.trim())
    .filter((note): note is string => !!note)
    .filter((note, index, all) => all.indexOf(note) === index);
  const weights = fusion
    ? [
        { key: "drawer_weight_visual", value: fusion.visualWeight },
        { key: "drawer_weight_sensor", value: fusion.sensorWeight },
        { key: "drawer_weight_satellite", value: fusion.satelliteWeight },
        { key: "drawer_weight_citizens", value: fusion.corroborationWeight ?? 0 },
      ].filter((weight) => weight.value > 0)
    : [];
  const isResolved = incident.status === "resolved";
  const isDispatched = incident.dispatchStatus === "dispatched";

  return (
    <div className="svd-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="svd-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="incident-drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="svd-drawer-head">
          <div>
            <p className="sv-eyebrow">{tierLabel}</p>
            <h2 id="incident-drawer-title">{incident.neighborhood || t("drawer_unknown_location")}</h2>
            <div className="svd-drawer-tags">
              <span className={`svd-tag svd-sev-${incident.severity}`}>{t(`severity_${incident.severity}`) || incident.severity}</span>
              <span className="svd-chip vs-title">
                <Icon name={HAZARD_ICON[incident.hazardType] ?? "particulate"} size={13} />
                {t(`hazard_${incident.hazardType}`)}
              </span>
              <span className="svd-chip">{t(`status_${incident.status}`) || incident.status}</span>
              {isDispatched && <span className="svd-chip is-ok">{t("dash_dispatched")}</span>}
              {incident.channel === "whatsapp" && <span className="svd-chip">WhatsApp</span>}
            </div>
          </div>
          <button type="button" className="svd-icon-btn" aria-label={t("common_close")} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        {incident.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- remote ImgBB evidence photo
          <img className="svd-drawer-photo" src={incident.photoUrl} alt={t("drawer_photo_alt")} />
        )}

        {incident.integrity && incident.integrity.flags.length > 0 && (
          <section className="svd-drawer-section svd-drawer-warn">
            <h3 className="vs-title">
              <Icon name="shield" size={14} />
              {t("drawer_integrity_title")}
            </h3>
            <ul className="svd-chip-row">
              {incident.integrity.flags.map((flag) => (
                <li key={flag} className="svd-chip is-warn">{t(`integrity_${flag}`)}</li>
              ))}
            </ul>
            <p className="svd-muted-note">{t("drawer_integrity_note")}</p>
          </section>
        )}

        {/* ── Evidence trail ───────────────────────────────────────────── */}
        <section className="svd-drawer-section">
          <h3 className="vs-title">
              <Icon name="layers" size={14} />
              {t("drawer_evidence_title")}
            </h3>
          {!evidence || !fusion ? (
            <p className="svd-muted-note">{t("command_detail_status_awaiting_class")}</p>
          ) : (
            <>
              <div className="svd-confidence">
                <strong>{fusion.finalConfidence}%</strong>
                <span>{t("drawer_fused_confidence")}</span>
              </div>
              <div className="svd-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, fusion.finalConfidence)}%` }} />
              </div>
              {weights.length > 0 && (
                <p className="svd-muted-note">
                  {weights.map((weight) => `${t(weight.key)} ${Math.round(weight.value * 100)}%`).join(" · ")}
                </p>
              )}
              <dl className="svd-facts">
                <div>
                  <dt>{t("drawer_citizen_reports")}</dt>
                  <dd>{evidence.citizenSignal.reportCount}</dd>
                </div>
                <div>
                  <dt>{t("drawer_station")}</dt>
                  <dd>
                    {sensor?.source === "CPCB" && sensor.stationName
                      ? `${sensor.stationName} · ${sensor.distanceKm?.toFixed(1) ?? "—"} km`
                      : t("drawer_no_station")}
                  </dd>
                </div>
                {sensor?.source === "CPCB" && (
                  <div>
                    <dt>{sensor.primaryName ?? "PM2.5"}</dt>
                    <dd>
                      {sensor.primaryValue ?? sensor.pm25 ?? "—"} µg/m³
                      {sensor.primaryDelta != null && (
                        <em>
                          {" "}
                          ({sensor.primaryDelta >= 0 ? "+" : ""}
                          {sensor.primaryDelta}% {t("drawer_vs_standard")})
                        </em>
                      )}
                      {sensor.lastUpdated && <small>{sensor.lastUpdated}</small>}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("drawer_satellite")}</dt>
                  <dd>
                    {satellite?.signal ?? "—"}
                    {satellite?.windowStart && satellite.windowEnd && (
                      <small>
                        {satellite.windowStart} → {satellite.windowEnd}
                        {satellite.currentProduct ? ` · ${satellite.currentProduct.includes("NRTI") ? "NRTI" : "OFFL"}` : ""}
                      </small>
                    )}
                  </dd>
                </div>
                {satellite?.firmsFireCount != null && (
                  <div>
                    <dt>{t("drawer_firms")}</dt>
                    <dd>
                      {satellite.firmsFireCount > 0
                        ? t("drawer_firms_value")
                            .replace("{count}", String(satellite.firmsFireCount))
                            .replace("{km}", String(satellite.firmsNearestKm ?? "—"))
                        : t("drawer_firms_none")}
                    </dd>
                  </div>
                )}
                {evidence.wind && (
                  <div>
                    <dt>{t("drawer_wind")}</dt>
                    <dd>
                      {t("drawer_wind_value")
                        .replace("{speed}", evidence.wind.speedMs.toFixed(1))
                        .replace("{dir}", compassLabel(evidence.wind.fromDeg))}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("drawer_first_seen")}</dt>
                  <dd>{t("drawer_age_ago").replace("{age}", getIncidentAge(incident.timestamp))}</dd>
                </div>
              </dl>
              <p className="svd-muted-note">{evidence.promotionReason}</p>
            </>
          )}
        </section>

        {/* ── Field context ────────────────────────────────────────────── */}
        <section className="svd-drawer-section">
          <div className="svd-drawer-section-head">
            <h3 className="vs-title">
              <Icon name="compass" size={14} />
              {t("drawer_context_title")}
            </h3>
            <button
              type="button"
              className="svd-action"
              disabled={!isOperator || contextState === "loading"}
              onClick={() => void loadContext()}
            >
              {contextState === "loading" ? t("drawer_loading") : context ? t("drawer_refresh") : t("drawer_context_load")}
            </button>
          </div>
          {!isOperator && <p className="svd-muted-note">{t("drawer_operator_only")}</p>}
          {contextError && <p className="svd-form-error">{contextError}</p>}
          {context && (
            <div className="svd-context">
              <div>
                <h4 className="vs-title">
                  <Icon name="wind" size={15} />
                  {t("drawer_upwind_title")}
                </h4>
                {context.attribution.status === "ok" ? (
                  <>
                    <p className="svd-muted-note">
                      {context.attribution.data.mode === "upwind" && context.attribution.data.wind
                        ? t("drawer_upwind_mode")
                            .replace("{dir}", compassLabel(context.attribution.data.wind.fromDeg))
                            .replace("{speed}", context.attribution.data.wind.speedMs.toFixed(1))
                        : context.attribution.data.mode === "calm"
                          ? t("drawer_calm_mode")
                          : t("drawer_no_wind_mode")}
                    </p>
                    {context.attribution.data.sources.length === 0 ? (
                      <p className="svd-muted-note">{t("drawer_no_sources")}</p>
                    ) : (
                      <ol className="svd-rank-list">
                        {context.attribution.data.sources.map((source, index) => (
                          <li key={`${source.name}-${index}`}>
                            <strong>{source.name}</strong>
                            <span>
                              {t(`source_kind_${source.kind}`)} · {source.distanceKm} km {compassLabel(source.bearingDeg)}
                              {source.offWindDeg !== null ? ` · ${source.offWindDeg}° ${t("drawer_off_wind")}` : ""}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {context.attribution.data.regionalUpwindFires > 0 && (
                      <p className="svd-callout">
                        {t("drawer_regional_fires").replace("{count}", String(context.attribution.data.regionalUpwindFires))}
                      </p>
                    )}
                    <p className="svd-muted-note">{t("drawer_attribution_caveat")}</p>
                  </>
                ) : (
                  <PieceNote piece={context.attribution} />
                )}
              </div>

              <div>
                <h4 className="vs-title">
                  <Icon name="school" size={15} />
                  {t("drawer_sites_title")}
                </h4>
                {context.sensitiveSites.status === "ok" ? (
                  context.sensitiveSites.data.length === 0 ? (
                    <p className="svd-muted-note">{t("drawer_sites_none")}</p>
                  ) : (
                    <ul className="svd-rank-list">
                      {context.sensitiveSites.data.slice(0, 6).map((site) => (
                        <li key={`${site.name}-${site.distanceKm}`}>
                          <strong className="vs-title">
                            <Icon name={site.kind === "hospital" ? "hospital" : "school"} size={14} />
                            {site.name}
                          </strong>
                          <span>
                            {t(`site_kind_${site.kind}`)} · {site.distanceKm} km
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  <PieceNote piece={context.sensitiveSites} />
                )}
              </div>

              <div>
                <h4 className="vs-title">
                  <Icon name="gauge" size={15} />
                  {t("drawer_gaq_title")}
                </h4>
                {context.googleAirQuality.status === "ok" ? (
                  <dl className="svd-facts">
                    <div>
                      <dt>{t("drawer_gaq_india")}</dt>
                      <dd>
                        {context.googleAirQuality.data.indiaAqi ?? "—"}
                        {context.googleAirQuality.data.indiaCategory && <small>{context.googleAirQuality.data.indiaCategory}</small>}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("drawer_gaq_uaqi")}</dt>
                      <dd>
                        {context.googleAirQuality.data.universalAqi ?? "—"}
                        {context.googleAirQuality.data.universalCategory && (
                          <small>{context.googleAirQuality.data.universalCategory}</small>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>PM2.5</dt>
                      <dd>
                        {context.googleAirQuality.data.pm25 ?? "—"} µg/m³
                        {sensor?.pm25 != null && (
                          <small>
                            {t("drawer_gaq_vs_station").replace("{value}", String(sensor.pm25))}
                          </small>
                        )}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <PieceNote piece={context.googleAirQuality} />
                )}
                {context.fires.status === "ok" && (
                  <p className="svd-muted-note">
                    {t("drawer_fires_10km").replace("{count}", String(context.fires.data.count))}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ── Work order ───────────────────────────────────────────────── */}
        <section className="svd-drawer-section">
          <div className="svd-drawer-section-head">
            <h3 className="vs-title">
              <Icon name="document" size={14} />
              {t("drawer_workorder_title")}
            </h3>
            <button
              type="button"
              className="svd-action"
              disabled={!isOperator || workOrderState === "loading"}
              onClick={() => void draftWorkOrder()}
            >
              {workOrderState === "loading"
                ? t("drawer_drafting")
                : workOrder
                  ? t("drawer_redraft")
                  : t("drawer_draft")}
            </button>
          </div>
          {workOrderError && <p className="svd-form-error">{workOrderError}</p>}
          {!workOrder ? (
            <p className="svd-muted-note">{t("drawer_workorder_empty")}</p>
          ) : (
            <div className="svd-workorder">
              <div className="svd-workorder-meta">
                <span className={`svd-chip ${workOrder.priority === "immediate" ? "is-warn" : ""}`}>
                  {t(`priority_${workOrder.priority}`)}
                </span>
                <span>{workOrder.department}</span>
              </div>
              <h4>{workOrder.subject}</h4>
              <p>{workOrder.summary}</p>
              <ol>
                {workOrder.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
              <div className="svd-viewnav" role="tablist" aria-label={t("drawer_language")}>
                {(["en", "hi"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    role="tab"
                    aria-selected={language === lang}
                    className={`svd-viewnav-item ${language === lang ? "is-active" : ""}`}
                    onClick={() => setLanguage(lang)}
                  >
                    {lang === "en" ? "English" : "हिन्दी"}
                  </button>
                ))}
              </div>
              <pre className="svd-workorder-body">{language === "en" ? workOrder.bodyEn : workOrder.bodyHi}</pre>
              {workOrder.evidenceCited.length > 0 && (
                <ul className="svd-chip-row">
                  {workOrder.evidenceCited.map((item) => (
                    <li key={item} className="svd-chip">{item}</li>
                  ))}
                </ul>
              )}
              <div className="svd-workorder-foot">
                <small>
                  {t("drawer_workorder_generated")
                    .replace("{model}", workOrder.model)
                    .replace("{time}", new Date(workOrder.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}
                </small>
                <button
                  type="button"
                  className="svd-action"
                  onClick={() => {
                    const text = `${workOrder.subject}\n${t("drawer_to")}: ${workOrder.department}\n\n${language === "en" ? workOrder.bodyEn : workOrder.bodyHi}\n\n${workOrder.actions.map((action, index) => `${index + 1}. ${action}`).join("\n")}`;
                    void navigator.clipboard?.writeText(text).then(() => onToast(t("drawer_copied")));
                  }}
                >
                  {t("drawer_copy")}
                </button>
              </div>
            </div>
          )}
        </section>

        {notes.length > 0 && (
          <section className="svd-drawer-section">
            <h3 className="vs-title">
              <Icon name="citizens" size={14} />
              {t("command_detail_citizen_notes")}
            </h3>
            <ul className="svd-notes">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Actions ──────────────────────────────────────────────────── */}
        <footer className="svd-drawer-actions">
          {actionError && <p className="svd-form-error">{actionError}</p>}
          {!isOperator && <p className="svd-muted-note">{t("drawer_operator_only")}</p>}
          {confirming ? (
            <div className="svd-confirm">
              <p>{t(`drawer_confirm_${confirming}`)}</p>
              <div>
                <button type="button" className="svd-action" onClick={() => setConfirming(null)}>
                  {t("common_cancel")}
                </button>
                <button
                  type="button"
                  className="svd-btn svd-btn-primary"
                  disabled={pendingAction !== null}
                  onClick={() => void runAction(confirming)}
                >
                  {pendingAction ? t("drawer_working") : t("resolve_confirm")}
                </button>
              </div>
            </div>
          ) : (
            <div className="svd-drawer-buttons">
              <button
                type="button"
                className="svd-btn svd-btn-primary"
                disabled={!isOperator || isDispatched || isResolved || pendingAction !== null}
                onClick={() => void runAction("dispatch")}
              >
                {isDispatched ? t("dash_dispatched") : pendingAction === "dispatch" ? t("dispatch_dispatching") : recommendedAction}
              </button>
              <button
                type="button"
                className="svd-action"
                disabled={!isOperator || isResolved || pendingAction !== null}
                onClick={() => setConfirming("resolve")}
              >
                {t("drawer_resolve")}
              </button>
              <button
                type="button"
                className="svd-action svd-action-danger"
                disabled={!isOperator || isResolved || pendingAction !== null}
                onClick={() => setConfirming("false_positive")}
              >
                {t("drawer_false_positive")}
              </button>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}
