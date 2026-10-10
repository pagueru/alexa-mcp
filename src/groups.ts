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
}

const call = <T = any>(fn: (cb: (e: any, b: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((e, b) => (e ? reject(e) : resolve(b))));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readGroups(alexa: AlexaRemote): Promise<Group[]> {
  const res: any = await call((cb) => alexa.getSmarthomeGroups(cb));
  return (res?.applianceGroups ?? []).map((g: any) => ({
    name: g.name,
    groupId: g.groupId ?? g.entityId,
    applianceIds: g.applianceIds ?? [],
    type: g.type,
  }));
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
  changes: { name?: string; applianceIds?: string[] },
): Promise<Group> {
  const cur = (await readGroups(alexa)).find((g) => g.groupId === groupId);
  if (!cur) throw new Error(`No group ${groupId}`);
  const body = {
    name: changes.name ?? cur.name,
    applianceIds: changes.applianceIds ?? cur.applianceIds,
    type: cur.type ?? "SPACE",
  };
  const result = await putGroup(alexa, groupId, body);
  if (result?.success !== true) throw new Error(`Update returned: ${JSON.stringify(result)}`);

  const after = (await readGroups(alexa)).find((g) => g.groupId === groupId);
  if (!after) throw new Error(`Group ${groupId} not found after the update.`);
  if (after.name !== body.name) throw new Error(`Rename not applied: group is still named "${after.name}".`);
  const dropped = missingMembers(body.applianceIds, after.applianceIds);
  if (dropped.length) {
    throw new Error(
      `Amazon dropped ${dropped.length} member(s) from "${after.name}": ${dropped.join(", ")}. ` +
        "A device that belongs to another group is not accepted; use alexa_move_to_group.",
    );
  }
  return after;
}

/**
 * Moves devices to another group: removes them from whichever group holds them, then
 * adds them to the target. If the add fails, the previous membership is restored.
 * `delayMs` is the pause between the two writes (Amazon needs a moment to release them).
 */
export async function moveToGroup(
  alexa: AlexaRemote,
  applianceIds: string[],
  toGroupId: string,
  delayMs = 1500,
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
  if (sources.length && delayMs) await sleep(delayMs);

  try {
    await updateGroup(alexa, toGroupId, { applianceIds: [...new Set([...target.applianceIds, ...applianceIds])] });
  } catch (e: any) {
    for (const s of sources) {
      await updateGroup(alexa, s.groupId, { applianceIds: s.applianceIds }).catch(() => undefined);
    }
    throw new Error(`Move failed, previous membership restored: ${e?.message ?? e}`);
  }
  return { moved: applianceIds, from: sources.map((s) => s.name), to: target.name };
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
