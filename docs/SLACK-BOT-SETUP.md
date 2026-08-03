# Creating the Slack bot for Reach Social alerting

**Who this is for:** whoever has permission to create a Slack app in the workspace.
**Time:** about 10 minutes.
**What you'll hand back:** two values — a bot token and a channel — delivered securely (see the
last section). You do **not** need access to the codebase or to any server.

## What this is

Reach Social's ad-rendering backend generates images and videos through a paid API. When a render
fails, stalls, or a run crashes, nobody currently finds out — the previous alerting transport was
never configured and is being removed. This bot is the replacement: the backend posts operational
alerts into one Slack channel so failures are visible without someone reading server logs.

The bot only ever **posts messages**. It does not read messages, does not join conversations, and
does not need access to anything beyond the one channel you point it at.

---

## Step 1 — Create the channel (or pick an existing one)

Create a channel for these alerts, e.g. **`#rs-alerts`**. Private is fine.

Optionally create a second channel for the most severe alerts only, e.g. `#rs-alerts-critical`.
This is optional — without it, everything goes to the one channel.

## Step 2 — Create the Slack app

1. Go to **https://api.slack.com/apps**
2. **Create New App** → **From scratch**
3. **App Name:** `Reach Social Alerts` (this is what shows as the message author)
4. **Pick a workspace:** choose the workspace containing the channel from Step 1
5. **Create App**

## Step 3 — Give it permission to post

1. In the left sidebar, open **OAuth & Permissions**
2. Scroll to **Scopes** → **Bot Token Scopes** → **Add an OAuth Scope**
3. Add **`chat:write`**
   - This is the only required scope. It lets the app post messages.
4. *Optional:* also add **`chat:write.public`**
   - This lets the app post to **public** channels without being invited to them first.
   - If you skip it, you must invite the bot to the channel in Step 5. Either approach works;
     inviting is the more conservative one and is what we'd suggest.

Please do **not** add any other scopes. The app has no reason to read messages, files, or user
data, and we'd rather it can't.

## Step 4 — Install it

1. Still on **OAuth & Permissions**, scroll to the top and click
   **Install to Workspace** (some workspaces label this *Install to `<workspace name>`*)
2. Review the permission screen and **Allow**

> If your workspace requires admin approval for new apps, this may create an approval request
> instead of installing immediately. An admin will need to approve it before the token works.

3. Copy the **Bot User OAuth Token**. It begins with **`xoxb-`**.

**This token is a credential — treat it like a password.** Anyone holding it can post as this app.
See the handback section below for how to send it.

## Step 5 — Let the bot into the channel

Go to the channel from Step 1 and type:

```
/invite @Reach Social Alerts
```

(Use whatever you named the app.) Required for **private** channels always, and for public channels
unless you added `chat:write.public` in Step 3.

## Step 6 — Get the channel ID (preferred over the name)

The channel **name** works, but the **ID** is more robust — it survives the channel being renamed.

1. Open the channel in Slack
2. Click the channel name at the top to open channel details
3. Scroll to the bottom of the **About** tab — the **Channel ID** is there with a copy button
4. It looks like `C0123ABCDEF`

## Step 7 — Verify it works before handing it over

This is worth doing, because it catches the two failures that are otherwise invisible. Run this in
a terminal, substituting your token and channel:

```bash
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer xoxb-YOUR-TOKEN-HERE" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C0123ABCDEF","text":"Reach Social alerting test — please ignore."}'
```

**Success** looks like a JSON response containing `"ok":true`, and the message appears in the
channel.

**Important:** Slack returns **HTTP 200 even when the post fails**. So don't judge by the
absence of an error — read the `ok` field in the response body. If you see `"ok":false`, the
`"error"` value tells you what's wrong:

| `error` value | What it means | Fix |
|---|---|---|
| `invalid_auth` / `not_authed` | Token is wrong, expired, or wasn't copied fully | Re-copy the Bot User OAuth Token |
| `channel_not_found` | Wrong channel ID, or the app isn't in the workspace that owns it | Re-check Step 6 |
| `not_in_channel` | Bot isn't a member of the channel | Do Step 5, or add `chat:write.public` |
| `is_archived` | Channel is archived | Use a live channel |
| `missing_scope` | `chat:write` wasn't added, or the app wasn't reinstalled after adding it | Redo Steps 3–4 — **adding a scope requires reinstalling** |

That last one catches people out: changing scopes does nothing until you reinstall the app.

---

## What to send back

Two values:

1. **Bot User OAuth Token** — the `xoxb-…` string
2. **Channel ID** (or `#channel-name`)
3. *If you made one:* the second channel ID for critical-only alerts

**Please don't send the token over Slack, email, or a chat message.** Use a password manager's
secure-share link (1Password, Bitwarden, etc.), or hand it over in person. If it does get sent
somewhere insecure, say so — regenerating it takes one click on the **OAuth & Permissions** page,
and it's much cheaper to rotate it than to wonder.

You can also just set it directly yourself if you have access to the Render dashboard — in which
case see the note below and nobody has to transmit it at all.

## For whoever configures the server

Only the **token** is a secret.

| Variable | Where |
|---|---|
| `SLACK_BOT_TOKEN` | **Render dashboard env** — never in a file, never committed |
| `SLACK_ALERT_CHANNEL` | `config/defaults.env` in the repo (a channel name isn't a secret) |
| `SLACK_ALERT_CHANNEL_FATAL` | `config/defaults.env` — *optional*, critical-only channel |

Set the token on **both** services — the web service (`liquidretail-backend`) and the background
worker (`liquidretail-backend-yjmx`). They alert on different things: the worker is where the
stalled-render sweep and the orphan reaper run, so a token on the web service alone leaves the most
important alerts silent.

Until the token is present, alerting stays **silently disabled** — one console line on the first
attempt, then quiet. Nothing else in the system changes behaviour.
