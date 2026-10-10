import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTrigger, describeActions, describeRoutine, describeGroup, roomsBySerial, nameOf } from "../dist/describe.js";

const names = new Map([
  ["SN1", "Echo Kitchen"],
  ["ent-lamp", "Kitchen ceiling"],
  ["AAA_1", "2nd Echo"],
]);

test("describeTrigger lists every voice phrase and reads schedules", () => {
  assert.equal(
    describeTrigger({ type: "CustomUtterance", payload: { utterance: "a", utterances: ["a", "b"] } }),
    'voice: "a" / "b"',
  );
  const sched = (rec) => ({
    type: "AbsoluteTimeSchedule",
    payload: { schedule: { triggerTime: "073000", recurrence: rec, timeZoneId: "Europe/Berlin" } },
  });
  assert.equal(describeTrigger(sched("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,MO,TU,WE,TH,FR,SA")), "time: 07:30 daily Europe/Berlin");
  assert.equal(describeTrigger(sched("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR")), "time: 07:30 MO,FR Europe/Berlin");
  assert.equal(describeTrigger({ type: "Other", payload: "{}" }), "Other");
});

const node = (type, operationPayload) => ({ "@type": "x.OpaquePayloadOperationNode", type, operationPayload });

test("describeActions walks nested nodes and resolves target and device names", () => {
  const seq = {
    nodesToExecute: [
      node("Alexa.System.Wait", { waitTimeInSeconds: 60 }),
      { nodesToExecute: [node("Alexa.SmartHome.Batch", { target: "ent-lamp", operations: [{ type: "turnOn" }] })] },
      node("Alexa.Speak", { textToSpeak: " hello ", deviceSerialNumber: "SN1" }),
      node("Alexa.TextCommand", { text: "what time is it" }),
    ],
  };
  assert.deepEqual(describeActions(seq, names), [
    "System.Wait 60s",
    "SmartHome.Batch turnOn → Kitchen ceiling",
    'Speak "hello" on Echo Kitchen',
    'TextCommand "what time is it"',
  ]);
  assert.deepEqual(describeActions(null, names), []);
});

test("describeRoutine summarises triggers and actions", () => {
  const r = {
    automationId: "id1",
    name: "R",
    status: "ENABLED",
    triggers: [{ type: "CustomUtterance", payload: { utterance: "go", utterances: ["go"] } }],
    sequence: { startNode: node("Alexa.SmartHome.Batch", { target: "ent-lamp", operations: [{ type: "turnOff" }] }) },
  };
  assert.deepEqual(describeRoutine(r, names), {
    automationId: "id1",
    name: "R",
    status: "ENABLED",
    triggers: ['voice: "go"'],
    actions: ["SmartHome.Batch turnOff → Kitchen ceiling"],
  });
});

const ECHO = '{"dsn":"SN1","deviceType":"DT1"}';
const speaker = (serial) => ({ defaultType: "AUDIO", defaultId: { deviceSerialNumber: serial } });
const groups = [
  { name: "Kitchen", groupId: "g1", applianceIds: [ECHO, "AAA_1"], defaults: [], childIds: [] },
  { name: "Hall", groupId: "g2", applianceIds: [], defaults: [speaker("SN2")], childIds: [] },
];

test("nameOf resolves ids, dsn JSON entries and falls back to the id", () => {
  assert.equal(nameOf("SN1", names), "Echo Kitchen");
  assert.equal(nameOf(ECHO, names), "Echo Kitchen");
  assert.equal(nameOf("unknown", names), "unknown");
  assert.equal(nameOf("ALEXA_CURRENT_DSN", names), "(the device that heard the command)");
});

test("describeGroup names the members and the audio default", () => {
  const g = describeGroup(groups[0], names);
  assert.deepEqual(g.members, [
    { id: ECHO, name: "Echo Kitchen" },
    { id: "AAA_1", name: "2nd Echo" },
  ]);
  assert.equal(g.audioDefault, null);
  const h = describeGroup(groups[1], new Map([["SN2", "Speaker"]]));
  assert.deepEqual(h.audioDefault, { serial: "SN2", name: "Speaker" });
});

test("roomsBySerial finds a device as a member or as an audio default", () => {
  const rooms = roomsBySerial(groups);
  assert.equal(rooms.get("SN1"), "Kitchen");
  assert.equal(rooms.get("SN2"), "Hall");
  assert.equal(rooms.get("SN3"), undefined);
});
