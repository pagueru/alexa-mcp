import type AlexaRemote from "alexa-remote2";
import { flattenAppliances } from "./util.js";
import { serialsOf, type Group } from "./groups.js";

/**
 * Human-readable views of routines, groups and devices: raw API objects carry opaque ids
 * (serial numbers, `AAA_…` appliance ids, `{"dsn":…}` JSON strings) that this module maps back
 * to the names the Alexa app shows.
 */

export type NameMap = Map<string, string>;

const call = <T = any>(fn: (cb: (e: any, b: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((e, b) => (e ? reject(e) : resolve(b))));

/** id → friendly name for devices (by serial) and smart-home appliances (by applianceId and entityId). */
export async function loadNames(alexa: AlexaRemote): Promise<NameMap> {
  const names: NameMap = new Map();
  const devices: any = await call((cb) => alexa.getDevices(cb)).catch(() => null);
  for (const d of devices?.devices ?? []) names.set(d.serialNumber, d.accountName);
  const phoenix: any = await call((cb) => alexa.getSmarthomeDevices(cb)).catch(() => null);
  for (const a of flattenAppliances(phoenix)) {
    if (a.applianceId) names.set(a.applianceId, a.friendlyName);
    if (a.entityId) names.set(a.entityId, a.friendlyName);
  }
  return names;
}

/** Name for an id; understands the `{"dsn":…}` JSON members of groups. Falls back to the id itself. */
export function nameOf(id: string, names: NameMap): string {
  if (id === "ALEXA_CURRENT_DSN") return "(the device that heard the command)"; // Amazon's placeholder
  const direct = names.get(id);
  if (direct) return direct;
  if (id.startsWith("{")) {
    try {
      const dsn = names.get(JSON.parse(id).dsn);
      if (dsn) return dsn;
    } catch {
      /* not JSON: keep the id */
    }
  }
  return id;
}

const parsePayload = (p: unknown): any => {
  if (typeof p !== "string") return p ?? {};
  try {
    return JSON.parse(p);
  } catch {
    return {};
  }
};

const ALL_DAYS = "SU,MO,TU,WE,TH,FR,SA";

/** `voice: "a" / "b"` or `time: 07:00 MO,TU America/Sao_Paulo`. */
export function describeTrigger(trigger: any): string {
  const p = parsePayload(trigger?.payload);
  if (trigger?.type === "CustomUtterance") {
    const phrases: string[] = p.utterances?.length ? p.utterances : [p.utterance];
    return `voice: ${phrases.map((u) => `"${u}"`).join(" / ")}`;
  }
  if (p.schedule) {
    const t = String(p.schedule.triggerTime ?? "");
    const days = String(p.schedule.recurrence ?? "").match(/BYDAY=([A-Z,]+)/)?.[1];
    const when = `${t.slice(0, 2)}:${t.slice(2, 4)}`;
    return `time: ${when}${days ? ` ${days === ALL_DAYS ? "daily" : days}` : ""} ${p.schedule.timeZoneId ?? ""}`.trim();
  }
  return String(trigger?.type ?? "unknown");
}

/** One line per action, in execution order, e.g. `SmartHome.Batch turnOn → Kitchen ceiling`. */
export function describeActions(node: any, names: NameMap, out: string[] = []): string[] {
  if (!node) return out;
  if (Array.isArray(node.nodesToExecute)) {
    node.nodesToExecute.forEach((n: any) => describeActions(n, names, out));
    return out;
  }
  const p = node.operationPayload ?? {};
  const bits = [String(node.type ?? "?").replace(/^Alexa\./, "")];
  const text = p.text ?? p.textToSpeak ?? p.content?.[0]?.speak?.value;
  if (text) bits.push(`"${String(text).trim()}"`);
  if (p.searchPhrase) bits.push(`"${p.searchPhrase}"`);
  if (p.waitTimeInSeconds) bits.push(`${p.waitTimeInSeconds}s`);
  if (Array.isArray(p.operations) && p.operations.length) {
    bits.push(p.operations.map((o: any) => o.type + (o.value !== undefined ? `=${JSON.stringify(o.value)}` : "")).join("+"));
  }
  if (p.target) bits.push(`→ ${nameOf(p.target, names)}`);
  if (p.deviceSerialNumber) bits.push(`on ${nameOf(p.deviceSerialNumber, names)}`);
  out.push(bits.join(" "));
  return out;
}

export function describeRoutine(routine: any, names: NameMap) {
  return {
    automationId: routine.automationId,
    name: routine.name,
    status: routine.status,
    triggers: (routine.triggers ?? []).map(describeTrigger),
    actions: describeActions(routine.sequence?.startNode, names),
  };
}

/** Group with named members and its AUDIO default device (where third-party speakers live). */
export function describeGroup(group: Group, names: NameMap) {
  const audio = serialsOf(group.defaults.filter((d) => d?.defaultType === "AUDIO"))[0];
  return {
    name: group.name,
    groupId: group.groupId,
    type: group.type,
    members: group.applianceIds.map((id) => ({ id, name: nameOf(id, names) })),
    audioDefault: audio ? { serial: audio, name: names.get(audio) ?? audio } : null,
  };
}

/** serial number → name of the group (room) the device is in, as a member or as the audio default. */
export function roomsBySerial(groups: Group[]): Map<string, string> {
  const rooms = new Map<string, string>();
  for (const g of groups) {
    for (const id of g.applianceIds) {
      if (!id.startsWith("{")) continue;
      try {
        const dsn = JSON.parse(id).dsn;
        if (dsn) rooms.set(dsn, g.name);
      } catch {
        /* not a device entry */
      }
    }
    for (const serial of serialsOf(g.defaults)) if (!rooms.has(serial)) rooms.set(serial, g.name);
  }
  return rooms;
}
