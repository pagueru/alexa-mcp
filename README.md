# alexa-mcp

[![CI](https://github.com/snordquist/alexa-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/snordquist/alexa-mcp/actions/workflows/ci.yml)

**The cleanup-focused Alexa MCP server.** An [MCP](https://modelcontextprotocol.io) server
that lets an AI assistant (Claude Code, Claude Desktop, …) **audit and clean up** your Amazon
Alexa account: list and inspect **routines**, list **smart-home devices** and **delete the
orphans** that pile up over time, plus read scenes and activity history.

It talks to Amazon's internal Alexa cloud API via
[`alexa-remote2`](https://github.com/Apollon77/alexa-remote).

> ### ⚠️ Disclaimer
> This project is **not affiliated with, endorsed by, or supported by Amazon.** There is **no
> official public API** for managing Alexa routines or smart-home devices — this tool uses the
> same **undocumented, reverse-engineered** endpoints the Alexa app uses, and may break at any
> time when Amazon changes them. Using it may violate Amazon's Terms of Service. **Use at your
> own risk**, against your own account only. The **login** happens on Amazon's real sign-in page
> (including 2FA); your credentials go only to Amazon — the local proxy only captures the
> resulting session token afterwards.

## Why this exists (vs. other Alexa MCP servers)

Other Alexa MCP servers focus on **control** (announcements/TTS, volume, lists). This one does
that **and** the things nothing else does — full **routine CRUD** (create/update/enable-disable/
delete) and **audit & cleanup** that **Amazon's own app can no longer do** (bulk-deleting
smart-home devices was removed from the Alexa web app). All reverse-engineered from the Alexa app
and verified end-to-end.

| Capability | This server |
|---|---|
| List / inspect routines (triggers + action sequence) | ✅ |
| **Create / update / enable-disable / delete routines** | ✅ (write-gated; verified) |
| Find routines with **broken references** (dangling targets) | ✅ |
| List smart-home devices (with source + reachability) | ✅ |
| **Delete a smart-home device** (orphan cleanup, reference-safe) | ✅ (write-gated) |
| Scenes, activity history | ✅ |
| **Rooms (groups)**: list with named members, create/rename/delete, move devices between rooms, set a speaker's room | ✅ (write-gated; verified) |
| **Rename** routines and devices; several voice phrases per routine | ✅ (write-gated; verified) |
| Readable listings: routine summaries, named group members, the room of every device | ✅ |
| Announcements / TTS / SSML, media transport, volume, DND | ✅ (write-gated) |
| Shopping / to-do lists (read + add) | ✅ |

It is **read-only by default**. Destructive tools are only registered when you explicitly opt in.

## Requirements

- **Node ≥ 20** (compiles with `tsc` to `dist/`, then runs on plain Node — no bundler).
- An Amazon account with **app-based 2FA** (SMS/email OTP no longer works with Amazon's login).
- Log in from a device/browser **without** the Alexa app installed (otherwise Amazon deep-links
  into the app instead of finishing the web login).

## Quick start

```bash
git clone https://github.com/snordquist/alexa-mcp.git
cd alexa-mcp
npm install
npm run doctor      # shows config + the login URL (no network)
npm run auth        # ONE-TIME: starts a local proxy, browser login incl. 2FA
npm run smoke       # lists devices, routines, scenes (read-only)
```

### `npm run auth` in detail

1. It starts a local proxy and prints a URL (default `http://127.0.0.1:3456/`).
2. Open that URL **in a browser on the same machine** and log in to your Amazon account (2FA).
3. On success the token (cookie + `refreshToken`) is written to `./.auth/alexa.json`
   (git-ignored) and refreshed automatically afterwards (every 4 days).
4. A smoke test (device list) runs. Done.

**Logging in from another device?** `proxyOwnIp` must match the URL in your browser exactly:

```bash
ALEXA_MCP_PROXY_IP=192.168.x.x npm run auth   # then open http://192.168.x.x:3456/
```

## Use as an MCP server

Read-only (recommended for auditing):

```bash
claude mcp add alexa -- node /ABSOLUTE/PATH/alexa-mcp/dist/index.js
```

With destructive tools enabled (delete routines / devices):

```bash
claude mcp add alexa --env ALEXA_MCP_ALLOW_WRITE=1 -- node /ABSOLUTE/PATH/alexa-mcp/dist/index.js
```

(Run `npm run build` first.)

## Tools

| Tool | Purpose | Writes |
|---|---|---|
| `alexa_list_devices` | Registered Echos / apps / Fire TVs, with the room (group) each is in | no |
| `alexa_list_routines` | All routines: id, name, status, triggers. `summary: true` returns readable lines instead (every voice phrase or schedule, every action with device names) | no |
| `alexa_get_routine` | One routine as raw JSON (incl. action sequence) | no |
| `alexa_list_scenes` | Smart-home entities incl. scenes | no |
| `alexa_get_activity` | Activity history (customer-history-records) | no |
| `alexa_list_smarthome_devices` | Smart-home devices with source (skill/Matter) + entity id — find orphans | no |
| `alexa_audit_broken_references` | Find routines whose action targets a device/scene/group that no longer exists | no |
| `alexa_get_volumes` | Current speaker volume of every device | no |
| `alexa_get_do_not_disturb` | Do-Not-Disturb status per device | no |
| `alexa_query_device` | Live state of smart-home devices/groups by applianceId | no |
| `alexa_list_groups` | Smart-home groups (rooms) with members by id and name, and the group's audio default device | no |
| `alexa_list_lists` | Shopping / to-do / custom lists | no |
| `alexa_get_list_items` | Items of a list by id | no |
| `alexa_get_player_info` | Now-playing / media player state of a device | no |
| `alexa_list_notifications` | Reminders / alarms / timers (id, time, label, status) | no |
| `alexa_create_routine` | Create a routine (voice- or time-triggered, one or several voice phrases) with one or more actions | **yes** |
| `alexa_update_routine` | Update a routine in place (full re-spec) | **yes** |
| `alexa_rename_routine` | Rename a routine, keeping every trigger, phrase, action and the status (works for routines `update` cannot express) | **yes** |
| `alexa_set_routine_enabled` | Enable/disable a routine by id (rebuilds + PUTs with flipped status) | **yes** |
| `alexa_trigger_routine` | Execute a routine now | **yes** |
| `alexa_delete_routine` | Delete a routine + verify | **yes** |
| `alexa_delete_smarthome_device` | Delete a smart-home device (orphan cleanup) — refuses if referenced by a routine/group unless `force`, and verifies removal | **yes** |
| `alexa_speak` | Make a device speak / announce (`speak` \| `announcement` \| `ssml`) | **yes** |
| `alexa_text_command` | Run a typed command as if spoken to a device | **yes** |
| `alexa_set_volume` | Set an Echo's speaker volume (0–100) | **yes** |
| `alexa_set_do_not_disturb` | Enable/disable Do-Not-Disturb on a device | **yes** |
| `alexa_media_control` | Media transport: play/pause/next/previous/forward/rewind/shuffle/repeat | **yes** |
| `alexa_add_list_item` | Add an item to a list | **yes** |
| `alexa_update_list_item` | Edit a list item's text / mark complete | **yes** |
| `alexa_delete_list_item` | Remove a list item | **yes** |
| `alexa_create_group` | Create a smart-home group (room/space) | **yes** |
| `alexa_update_group` | Rename a group / set members (read-modify-write, verified: fails if Amazon drops a member) | **yes** |
| `alexa_move_to_group` | Move devices from their current group into another (Amazon drops a device added to a second group) | **yes** |
| `alexa_set_group_audio_default` | Set/clear the AUDIO default device of a group (how third-party speakers get a room; the group PUT wipes it otherwise) | **yes** |
| `alexa_rename_device` | Rename an Echo or other registered device by serial or name, verified | **yes** |
| `alexa_delete_group` | Delete a smart-home group (members untouched) | **yes** |
| `alexa_set_smarthome_enablement` | Enable/disable a smart-home device | **yes** |
| `alexa_create_reminder` | Create a reminder on a device | **yes** |
| `alexa_create_alarm` | Create an alarm (< 1 year out; it rings) | **yes** |
| `alexa_delete_notification` | Delete a reminder / alarm / timer by id | **yes** |

Most write tools also accept `dryRun: true` to preview the request/plan without executing.

Routine **create/update** were reverse-engineered from the Alexa app and verified end-to-end; see
[ARCHITECTURE.md](./ARCHITECTURE.md) for the exact write-API (the trigger `payload` is
double-encoded and the action `operationPayload` must be `/operation/validate`-normalized — the
tools handle both). Example create:

```json
{ "name": "Gute Nacht Ansage", "triggerUtterance": "gute nacht",
  "actions": [ { "type": "Alexa.TextCommand", "operationPayload": { "text": "schlaf gut" } } ],
  "confirm": true }
```

Several voice phrases for one routine (the app allows many; the first is the primary one):

```json
{ "name": "Light - Kitchen ceiling - On",
  "triggerUtterances": ["turn on the kitchen", "kitchen light on", "light up the kitchen"],
  "actions": [ { "type": "Alexa.SmartHome.Batch",
                 "operationPayload": { "target": "<entityId from alexa_list_smarthome_devices>",
                                       "operations": [ { "type": "turnOn" } ] } } ],
  "confirm": true }
```

Write tools are only registered when `ALEXA_MCP_ALLOW_WRITE=1`, and each destructive call also
requires an explicit `confirm: true` argument.

## Working with routines

- **Find a routine by what it does:** `alexa_list_routines` with `summary: true` shows, per routine,
  every voice phrase or the schedule, and every action in order with device names resolved
  (`SmartHome.Batch turnOn → Kitchen ceiling`, `Speak "…" on Echo Kitchen`). The raw listing
  carries full payloads and is several times longer.
- **Rename without losing anything:** `alexa_rename_routine` rebuilds the routine from its current
  state and changes only the name. `alexa_update_routine` re-specs the whole routine, so it only
  fits routines it can express (one trigger, plain actions); use rename for the rest.
- **Voice phrases:** pass `triggerUtterances` (a list) instead of `triggerUtterance` to register
  several phrases.
- **Schedules:** `triggerTime` is `HH:MM`; without `triggerDays` the routine runs every day (sent as
  a weekly rule with all seven days, which is how the app stores it; `FREQ=DAILY` is rejected).
- **Always read back:** Amazon answers a refused write with HTTP 200 and a `message`; the write
  tools turn that into an error and verify the result, but a read after a write can still lag for a
  moment.

## Rooms, groups and devices

- A **group** (`type: SPACE`) is a room. Its **members** are listed by id: an Echo has two entries,
  the `{"dsn":"…","deviceType":"…"}` JSON and an `AAA_…` id; lamps and plugs use `SKILL_…` ids.
  `alexa_list_groups` shows each member with its name.
- **Third-party speakers** (e.g. Xiaomi with Alexa built in) are refused as members. The app stores
  their room as the group's **audio default** (`defaults`); set it with
  `alexa_set_group_audio_default`. `alexa_list_devices` shows the room either way.
- **Moving an Echo or a smart-home device:** use `alexa_move_to_group` (pass every id of the device).
  Amazon accepts a group write and silently drops a device that still belongs to another group; the
  tool takes it out of the old group first, retries the add and restores the old group if it fails.
  A device added to a group recently may be refused for a while (longer than ~20 s was measured).
- **Group writes never wipe the default device:** the group `PUT` is a full replace and erases the
  audio default when it is left out, so the tools send the current one back.
- **Rename a device:** `alexa_rename_device` (serial or exact name). Integrations that build names
  from it change too, e.g. Home Assistant's `alexa_media_player` notify service
  (`notify.alexa_media_<name>`), while the entity id in HA's registry stays.

## Using a non-German account

The defaults are German (`amazon.de`, `de-DE`, `Europe/Berlin`). Set these before `npm run auth`
and for the server; example for Brazil:

```bash
export ALEXA_MCP_AMAZON_PAGE=amazon.com.br
export ALEXA_MCP_ACCEPT_LANGUAGE=pt-BR
export ALEXA_MCP_PROXY_LANGUAGE=pt_BR          # language of the login page
export ALEXA_MCP_MARKETPLACE_ID=A2Q3Y263D00KWC # marketplace of voice triggers
export ALEXA_MCP_TIMEZONE=America/Sao_Paulo
```

The marketplace id of your account is visible in the voice triggers of your existing routines
(`alexa_get_routine` → `triggers[].payload.marketplaceId`).

## Amazon quirks worth knowing

- Refused writes come back as HTTP 200 with `{"message":"…"}` (`Input failed to validate.`,
  `Object not found.`); some are accepted and silently dropped (group members).
- Writes take effect with a delay; reads right after can be stale.
- In batch work (many routines or groups), pause about 3 s between calls; fast bursts make Amazon
  hold the answers until the client times out. Validating a `SmartHome.Batch` action can take ~20 s.
- Text sent without `charset=utf-8` is stored as Latin-1 (`sÃ£o`); the tools send the charset.
- `ALEXA_CURRENT_DSN` in an action means "the device that heard the command".

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ALEXA_MCP_AMAZON_PAGE` | `amazon.de` | Login region (e.g. `amazon.com`, `amazon.co.uk`) |
| `ALEXA_MCP_ACCEPT_LANGUAGE` | `de-DE` | Accept-Language header and locale of created/updated routines |
| `ALEXA_MCP_PROXY_LANGUAGE` | `en_US` | `language=` param on the proxy login page (e.g. `de_DE`) |
| `ALEXA_MCP_MARKETPLACE_ID` | `A1PA6795UKMFR9` (DE) | Marketplace of voice triggers (e.g. `A2Q3Y263D00KWC` for amazon.com.br) |
| `ALEXA_MCP_TIMEZONE` | `Europe/Berlin` | Default time zone of scheduled routines |
| `ALEXA_MCP_PROXY_IP` | `127.0.0.1` | Must match the URL you open during login |
| `ALEXA_MCP_PROXY_PORT` | `3456` | Proxy port for the login |
| `ALEXA_MCP_PROXY_BIND` | `0.0.0.0` | Proxy bind address |
| `ALEXA_MCP_REFRESH_MS` | `345600000` (4 d) | Token refresh interval |
| `ALEXA_MCP_ALLOW_WRITE` | – | `1` enables the destructive tools |
| `ALEXA_MCP_AUTH_PATH` | `.auth/alexa.json` | Token file location |

## Security & privacy

- The session token is stored **only** in `./.auth/alexa.json` (mode `0600`, git-ignored). It is
  never logged or committed. Treat that file like a password.
- The login proxy binds to `0.0.0.0` by default so you can log in from another device; set
  `ALEXA_MCP_PROXY_BIND=127.0.0.1` to keep it local-only.
- To fully sign out, delete `./.auth/alexa.json` (and remove the registered "device" from
  *Amazon → Manage Your Content and Devices*).

## Known limitations

- **Unofficial API** — can break whenever Amazon changes it.
- **Routine deletion** uses `DELETE /api/behaviors/automations/{id}` (the non-`v2` path; `v2` is
  read-only). Verified live, with a read-back after the delete.
- **Third-party speakers cannot be group members**; their room is the group's audio default.
- **Device deletion may not be permanent** if the underlying source still advertises the device:
  a skill that is still linked (and whose backend responds) or a Matter bridge will re-add it on
  the next discovery. Orphans whose backend is gone (unlinked skill, removed integration) stay
  deleted.
- **Matter duplicate devices** (the same device appearing once per Alexa Echo/hub that acts as a
  Matter controller) are an Alexa-side artifact, not a bridge misconfiguration. Deleting the
  redundant copies works, but new ones can reappear if the Matter bridge is re-commissioned.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the auth flow, endpoint reference, and
implementation notes.

## License

[MIT](./LICENSE) © Sascha Nordquist
