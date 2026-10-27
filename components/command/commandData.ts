import type { Incident } from "@/lib/types";

const actionByHazard: Record<Incident["hazardType"], string> = {
  fire: "Dispatch fire/cleanup crew",
  smog: "Issue traffic advisory",
  dust: "Deploy water-mist cannon",
  industrial: "Notify pollution control board",
  // Sensor/satellite flagged elevated particulate but the source isn't
  // confirmed — send a team to identify it before committing fire/traffic/
  // dust-specific resources.
  particulate: "Dispatch inspection team to confirm source",
};

const actionKeyByHazard: Record<Incident["hazardType"], string> = {
  fire: "action_dispatch_fire_cleanup",
  smog: "action_issue_traffic_advisory",
  dust: "action_deploy_water_mist",
  industrial: "action_notify_pollution_board",
  particulate: "action_dispatch_inspection",
};

export function getRecommendedAction(incident: Incident) {
  return actionByHazard[incident.hazardType];
}

export function getRecommendedActionKey(incident: Incident) {
  return actionKeyByHazard[incident.hazardType];
}

export function formatStatus(status: Incident["status"]) {
  return status.replace("_", " ");
}

export function getIncidentAge(timestamp: string) {
  const then = new Date(timestamp).getTime();
  const now = Date.now();
  const minutes = Math.max(1, Math.round((now - then) / 60000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}
