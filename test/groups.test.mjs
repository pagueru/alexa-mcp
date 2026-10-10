import { test } from "node:test";
import assert from "node:assert/strict";
import { missingMembers, updateGroup, moveToGroup, renameDevice, setGroupAudioDefault, timing } from "../dist/groups.js";

timing.settleMs = 0;

const ECHO = '{"dsn":"SN1","deviceType":"DT1"}';

// Stand-in for the group endpoints. Like Amazon, a PUT answers success but silently
// drops members that already belong to another group, or that `refuse` lists for that group.
const fakeGroups = (groups, { refuse = {} } = {}) => ({
  groups,
  getSmarthomeGroups(cb) {
    cb(null, { applianceGroups: groups.map((g) => ({ ...g, applianceIds: [...g.applianceIds] })) });
  },
  httpsGet(_noCheck, path, cb, flags) {
    const g = groups.find((x) => x.groupId === decodeURIComponent(path.split("/").pop()));
    const body = JSON.parse(flags.data);
    const others = groups.filter((x) => x !== g).flatMap((x) => x.applianceIds);
    g.name = body.name;
    g.defaults = body.defaults ?? []; // like Amazon, a PUT without defaults wipes them
    g.applianceIds = body.applianceIds.filter((m) => !others.includes(m) && !(refuse[g.groupId] ?? []).includes(m));
    cb(null, { success: true });
  },
});

const house = () => [
  { name: "Kitchen", groupId: "g1", applianceIds: [ECHO, "AAA_1"], type: "SPACE" },
  { name: "Hall", groupId: "g2", applianceIds: ["LAMP"], type: "SPACE" },
];

test("missingMembers lists requested ids that are not in the group", () => {
  assert.deepEqual(missingMembers(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(missingMembers([], ["b"]), []);
});

test("updateGroup throws when Amazon silently drops a member", async () => {
  const alexa = fakeGroups(house());
  await assert.rejects(updateGroup(alexa, "g2", { applianceIds: ["LAMP", ECHO] }), {
    message: /dropped 1 member\(s\) from "Hall".*alexa_move_to_group/,
  });
});

test("updateGroup renames a group and keeps its members", async () => {
  const alexa = fakeGroups(house());
  const g = await updateGroup(alexa, "g2", { name: "Hallway" });
  assert.equal(g.name, "Hallway");
  assert.deepEqual(g.applianceIds, ["LAMP"]);
});

test("moveToGroup takes the devices out of the old group before adding them", async () => {
  const alexa = fakeGroups(house());
  const res = await moveToGroup(alexa, [ECHO, "AAA_1"], "g2", 0);
  assert.deepEqual(res, { moved: [ECHO, "AAA_1"], from: ["Kitchen"], to: "Hall" });
  assert.deepEqual(alexa.groups[0].applianceIds, []);
  assert.deepEqual(alexa.groups[1].applianceIds, ["LAMP", ECHO, "AAA_1"]);
});

test("moveToGroup restores the previous membership when the add fails", async () => {
  const alexa = fakeGroups(house(), { refuse: { g2: [ECHO] } });
  await assert.rejects(moveToGroup(alexa, [ECHO], "g2", 0), { message: /previous membership restored/ });
  assert.deepEqual(alexa.groups[0].applianceIds, [ECHO, "AAA_1"]);
  assert.deepEqual(alexa.groups[1].applianceIds, ["LAMP"]);
});

// Stand-in for the device list; `stuck` makes the rename silently not apply.
const fakeDevices = ({ stuck = false } = {}) => {
  const devices = [{ serialNumber: "SN1", accountName: "Echo Kitchen" }];
  return {
    devices,
    getDevices(cb) { cb(null, { devices: devices.map((d) => ({ ...d })) }); },
    renameDevice(serial, name, cb) {
      if (!stuck) devices.find((d) => d.serialNumber === serial).accountName = name;
      cb(null, { accountName: name });
    },
  };
};

test("renameDevice renames by serial or current name and verifies the result", async () => {
  const alexa = fakeDevices();
  assert.deepEqual(await renameDevice(alexa, "SN1", "Echo Hall"), { serial: "SN1", from: "Echo Kitchen", name: "Echo Hall" });
  assert.equal((await renameDevice(alexa, "Echo Hall", "Echo Den")).name, "Echo Den");
});

test("renameDevice throws on an unknown device or a rename that did not apply", async () => {
  await assert.rejects(renameDevice(fakeDevices(), "nope", "x"), { message: /No device/ });
  await assert.rejects(renameDevice(fakeDevices({ stuck: true }), "SN1", "x"), { message: /Rename not applied/ });
});

test("moveToGroup retries the add while Amazon still holds the device in the old group", async () => {
  const alexa = fakeGroups(house());
  let refusals = 2;
  const put = alexa.httpsGet;
  alexa.httpsGet = (noCheck, path, cb, flags) => {
    const body = JSON.parse(flags.data);
    if (path.endsWith("/g2") && body.applianceIds.includes(ECHO) && refusals-- > 0) {
      return cb(null, { success: true }); // accepted, but the member is not stored
    }
    return put(noCheck, path, cb, flags);
  };
  await moveToGroup(alexa, [ECHO], "g2", 0);
  assert.ok(alexa.groups[1].applianceIds.includes(ECHO));
});

// A third-party speaker: not accepted as a group member, only as the group's AUDIO default.
const speaker = (serial) => ({
  defaultType: "AUDIO",
  endpointType: "ALEXA",
  defaultId: { __type: "AmazonBridgeIdentity:x", deviceType: "SPK", deviceSerialNumber: serial },
});

const withSpeaker = () => {
  const alexa = fakeGroups([
    { name: "Kitchen", groupId: "g1", applianceIds: [], defaults: [speaker("SN2")], childIds: [], type: "SPACE" },
    { name: "Hall", groupId: "g2", applianceIds: ["LAMP"], defaults: [], childIds: [], type: "SPACE" },
  ]);
  alexa.getDevices = (cb) => cb(null, { devices: [{ serialNumber: "SN2", accountName: "Speaker", deviceType: "SPK" }] });
  return alexa;
};

test("updateGroup keeps the group's default devices", async () => {
  const alexa = withSpeaker();
  await updateGroup(alexa, "g1", { name: "Kitchen 2" });
  assert.equal(alexa.groups[0].defaults.length, 1);
  assert.equal(alexa.groups[0].defaults[0].defaultId.deviceSerialNumber, "SN2");
});

test("setGroupAudioDefault moves a third-party speaker's room by its default", async () => {
  const alexa = withSpeaker();
  const res = await setGroupAudioDefault(alexa, "g2", "Speaker");
  assert.deepEqual(res, { group: "Hall", device: "SN2", previous: [], clearedFrom: ["Kitchen"] });
  assert.equal(alexa.groups[0].defaults.length, 0);
  assert.equal(alexa.groups[1].defaults[0].defaultId.deviceSerialNumber, "SN2");
  assert.deepEqual(alexa.groups[1].applianceIds, ["LAMP"]);
});

test("setGroupAudioDefault clears the default with null and rejects unknown devices", async () => {
  const alexa = withSpeaker();
  const res = await setGroupAudioDefault(alexa, "g1", null);
  assert.deepEqual(res.previous, ["SN2"]);
  assert.equal(alexa.groups[0].defaults.length, 0);
  await assert.rejects(setGroupAudioDefault(alexa, "g2", "nope"), { message: /No device/ });
});
