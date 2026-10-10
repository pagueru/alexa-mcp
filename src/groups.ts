import type AlexaRemote from "alexa-remote2";

/**
 * Smart-home groups (rooms/spaces) and device naming.
 *
 * Amazon answers some group writes with success while silently dropping members it
 * refuses (observed: an Echo added to a second group while it still belongs to the
 * first). Every write here therefore re-reads the group and fails on any mismatch.
 */

export interface Group {
  name: string;
  groupId: string;
  applianceIds: string[];
  type?: string;
  /** Default devices of the group (e.g. the AUDIO device). Third-party speakers live here, not in applianceIds. */
  defaults: any[];
  childIds: string[];
}

const call = <T = any>(fn: (cb: (e: any, b: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((e, b) => (e ? reject(e) : resolve(b))));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Verification re-reads (tests set settleMs to 0). */
export const timing = { verifyRetries: 3, settleMs: 1000 };

export async function readGroups(alexa: AlexaRemote): Promise<Group[]> {
  const res: any = await call((cb) => alexa.getSmarthomeGroups(cb));
  return (res?.applianceGroups ?? []).map((g: any) => ({
    name: g.name,
    groupId: g.groupId ?? g.entityId,
    applianceIds: g.applianceIds ?? [],
    type: g.type,
    defaults: g.defaults ?? [],
    childIds: g.childIds ?? [],
  }));
}

const AUDIO_IDENTITY_TYPE = "AmazonBridgeIdentity:http://internal.amazon.com/coral/com.amazon.dee.web.coral.model/";

/** Serial numbers of the default devices in a group's `defaults` list. */
export function serialsOf(defaults: any[]): string[] {
  return (defaults ?? []).map((d) => d?.defaultId?.deviceSerialNumber).filter(Boolean);
}

/** Members in `requested` that are not in `actual`. */
export function missingMembers(requested: string[], actual: string[]): string[] {
  const have = new Set(actual);
  return requested.filter((id) => !have.has(id));
}

function putGroup(alexa: AlexaRemote, groupId: string, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    (alexa as any).httpsGet(
      true,
      `/api/phoenix/group/${encodeURIComponent(groupId)}`,
      (err: any, b: any) => (err ? reject(err) : resolve(b ?? { success: true })),
      { method: "PUT", data: JSON.stringify(body), headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  });
}

/**
 * Renames a group and/or replaces its members (read-modify-write; the PUT is a full
 * replace), then reads the group back and throws if the name or any requested member
 * did not stick.
 */
export async function updateGroup(
  alexa: AlexaRemote,
  groupId: string,
  changes: { name?: string; applianceIds?: string[]; defaults?: any[] },
): Promise<Group> {
  const cur = (await readGroups(alexa)).find((g) => g.groupId === groupId);
  if (!cur) throw new Error(`No group ${groupId}`);
  const body = {
    name: changes.name ?? cur.name,
    applianceIds: changes.applianceIds ?? cur.applianceIds,
    type: cur.type ?? "SPACE",
    // The PUT is a full replace: leaving these out wipes the group's default devices.
    defaults: changes.defaults ?? cur.defaults,
    childIds: cur.childIds,
  };
  const result = await putGroup(alexa, groupId, body);
  if (result?.success !== true) throw new Error(`Update returned: ${JSON.stringify(result)}`);

  // Amazon applies the write with a delay: re-read a few times before declaring it lost.
  let problem = "";
  for (let attempt = 0; attempt <= timing.verifyRetries; attempt++) {
    if (attempt && timing.settleMs) await sleep(timing.settleMs);
    const after = (await readGroups(alexa)).find((g) => g.groupId === groupId);
    problem = after ? checkUpdate(after, body, changes) : `Group ${groupId} not found after the update.`;
    if (!problem && after) return after;
  }
  throw new Error(problem);
}

function checkUpdate(after: Group, body: { name: string; applianceIds: string[] }, changes: { defaults?: any[] }): string {
  if (after.name !== body.name) return `Rename not applied: group is still named "${after.name}".`;
  if (changes.defaults && serialsOf(after.defaults).join() !== serialsOf(changes.defaults).join()) {
    return `Default device not applied: group "${after.name}" has [${serialsOf(after.defaults)}].`;
  }
  const dropped = missingMembers(body.applianceIds, after.applianceIds);
  if (dropped.length) {
    return (
      `Amazon dropped ${dropped.length} member(s) from "${after.name}": ${dropped.join(", ")}. ` +
      "A device that already belongs to another group is refused (use alexa_move_to_group); " +
      "some third-party devices are never accepted in groups (use alexa_set_group_audio_default)."
    );
  }
  return "";
}

/**
 * Moves devices to another group: removes them from whichever group holds them, then
 * adds them to the target. If the add fails, the previous membership is restored.
 * `delayMs` is the base pause before each add attempt (attempt n waits n × delayMs).
 */
export async function moveToGroup(
  alexa: AlexaRemote,
  applianceIds: string[],
  toGroupId: string,
  delayMs = 1500,
  attempts = 4,
): Promise<{ moved: string[]; from: string[]; to: string }> {
  const groups = await readGroups(alexa);
  const target = groups.find((g) => g.groupId === toGroupId);
  if (!target) throw new Error(`No group ${toGroupId}`);
  const sources = groups.filter(
    (g) => g.groupId !== toGroupId && g.applianceIds.some((id) => applianceIds.includes(id)),
  );

  for (const s of sources) {
    await updateGroup(alexa, s.groupId, { applianceIds: s.applianceIds.filter((id) => !applianceIds.includes(id)) });
  }
  // Amazon releases a device from its old group with a variable delay (measured: the same
  // add was refused after 1.5 s and accepted right after), so retry with a growing pause.
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (sources.length && delayMs) await sleep(delayMs * attempt);
    try {
      await updateGroup(alexa, toGroupId, { applianceIds: [...new Set([...target.applianceIds, ...applianceIds])] });
      return { moved: applianceIds, from: sources.map((s) => s.name), to: target.name };
    } catch (e: any) {
      lastError = e;
    }
  }
  for (const s of sources) {
    await updateGroup(alexa, s.groupId, { applianceIds: s.applianceIds }).catch(() => undefined);
  }
  throw new Error(
    `Move failed, previous membership restored: ${lastError?.message ?? lastError} ` +
      "A device added to a group recently may need a few minutes before it can join another one.",
  );
}

/**
 * Renames a device (Echo, speaker, …) by serial number or exact current name and
 * verifies the new name by reading the device list back.
 */
export async function renameDevice(
  alexa: AlexaRemote,
  serialOrName: string,
  name: string,
): Promise<{ serial: string; from: string; name: string }> {
  const before: any = await call((cb) => alexa.getDevices(cb));
  const dev = (before?.devices ?? []).find((d: any) => d.serialNumber === serialOrName || d.accountName === serialOrName);
  if (!dev) throw new Error(`No device with serial or name "${serialOrName}".`);

  await call((cb) => (alexa as any).renameDevice(dev.serialNumber, name, cb));

  const after: any = await call((cb) => alexa.getDevices(cb));
  const now = (after?.devices ?? []).find((d: any) => d.serialNumber === dev.serialNumber);
  if (now?.accountName !== name) throw new Error(`Rename not applied: device is still named "${now?.accountName}".`);
  return { serial: dev.serialNumber, from: dev.accountName, name };
}

/**
 * Sets the AUDIO default device of a group (null clears it). This is how the app keeps the
 * location of third-party speakers (e.g. Xiaomi), which are refused as group members. A device
 * lives in one room, so it is also taken out of every other group where it was the default.
 * `device` is a serial number or an exact account name from the device list.
 */
export async function setGroupAudioDefault(
  alexa: AlexaRemote,
  groupId: string,
  device: string | null,
): Promise<{ group: string; device: string | null; previous: string[]; clearedFrom: string[] }> {
  const groups = await readGroups(alexa);
  const target = groups.find((g) => g.groupId === groupId);
  if (!target) throw new Error(`No group ${groupId}`);

  let defaults: any[] = target.defaults.filter((d) => d?.defaultType !== "AUDIO");
  let serial: string | null = null;
  if (device !== null) {
    const res: any = await call((cb) => alexa.getDevices(cb));
    const dev = (res?.devices ?? []).find((d: any) => d.serialNumber === device || d.accountName === device);
    if (!dev) throw new Error(`No device with serial or name "${device}".`);
    serial = dev.serialNumber;
    defaults = [
      ...defaults,
      {
        defaultType: "AUDIO",
        endpointType: "ALEXA",
        defaultId: { __type: AUDIO_IDENTITY_TYPE, deviceType: dev.deviceType, deviceSerialNumber: dev.serialNumber },
      },
    ];
  }

  const clearedFrom: string[] = [];
  for (const g of groups) {
    if (g.groupId === groupId || !serial || !serialsOf(g.defaults).includes(serial)) continue;
    await updateGroup(alexa, g.groupId, { defaults: g.defaults.filter((d) => d?.defaultId?.deviceSerialNumber !== serial) });
    clearedFrom.push(g.name);
  }
  const previous = serialsOf(target.defaults);
  await updateGroup(alexa, groupId, { defaults });
  return { group: target.name, device: serial, previous, clearedFrom };
}
