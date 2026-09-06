# Setting up prompt testing on your computer

For running video-ad prompt experiments locally. Written for someone who is
**not** a programmer — every step is "install this" or "paste this". You will
not need to understand any code.

Claude does the work. Your job is to tell it what you want to test.

---

## Step 1 — Install the GitHub CLI

Lets your computer download our private code.

1. Go to **https://cli.github.com** → **Download for macOS** (or Windows).
2. Open the file and click through the installer.

*Already have `gh` installed and logged in? Skip to Step 3.*

## Step 2 — Connect it to your GitHub account

Open **Terminal** (`Cmd + Space`, type `Terminal`, Enter), paste this, press Enter:

```
gh auth login
```

Answer with the arrow keys: **GitHub.com** → **HTTPS** → **Yes** (authenticate
Git) → **Login with a web browser**. Copy the code it shows, press Enter, paste
the code in the browser, click **Authorize**.

## Step 3 — Download the code

Paste these one at a time:

```
mkdir -p ~/Projects
cd ~/Projects
gh repo clone Emami-RS-Project/liquidretail_adgen
```

## Step 4 — Install Claude Code

1. **https://claude.com/download** → install → sign in.
   (Needs a paid Claude plan — Pro, Max, Team or Enterprise.)
2. Open the **Code** tab.
3. Environment picker at the bottom: make sure **Local** is selected.
4. **Select folder** → `Projects` → `liquidretail_adgen`.

> ⚠️ If you ever switch branches or pull new code, **quit Claude Code and
> reopen it**. It only picks up the project's tools when a session starts.

## Step 5 — Get the keys from Nick

You need two, and optionally a third:

| Key | What it's for |
|---|---|
| `GEMINI_VIDEO_API_KEY` | **The important one.** This is the model production actually uses. |
| `MONGODB_URI` | **Also important.** Lets you say "test product X from our catalog" and get that product's real photos and real brand look — instead of hand-pasting one image URL and getting placeholder styling. |
| `ATLAS_API_KEY` | Only if you want to try the older Atlas models. |

Save the file Nick sends somewhere you can find it. You don't have to open it.

## Step 6 — Say hello

Paste this as your **first message** to Claude:

> I'm not a programmer — please do everything yourself and never ask me to run
> a command. Explain things in plain English.
>
> First, get this project working and tell me what you fixed:
> 1. Switch to the `master` branch and pull the latest.
> 2. Make sure Node.js 20 or newer is installed; install it if not.
> 3. Run `npm install` here — the checked-in dependencies are incomplete.
> 4. Set up `GEMINI_VIDEO_API_KEY`, `ATLAS_API_KEY` and `MONGODB_URI`. Ask me
>    for them — Nick sent me a file. If anything else is missing or broken,
>    figure out what's needed and fix it yourself.
>
> Then read `.claude/skills/rpd-experiments/SKILL.md` and use that skill in
> **newbie mode**.
>
> Whenever I ask to test a prompt:
> - Make **one** video unless I explicitly ask to compare things
> - Compare against **production** as the baseline unless I say otherwise
> - Show me the seed images as numbered thumbnails and ask what order I want
> - Always do the free dry run first and tell me the cost before spending
> - Never spend money without asking me
> - Explain the results in plain English
>
> Start now and tell me when I can run my first test.

Then just describe what you want:

> Make me a 9:16 video for the Pelagic fishing shirt, and show me the seed
> images first so I can pick the order.

> Test whether "hard cuts only" beats what we ship today.

---

## What things cost

One video is about **$1.00**. Claude will always dry-run first (free) and tell
you the price before spending anything.

Two useful facts:

- **A dry run costs nothing** and shows you the exact prompt that would be sent.
- **The tool refuses to bill twice for the same video.** If two test variants
  would produce an identical result, it stops and says so rather than charging
  you for a duplicate.

## If something goes wrong

Tell Claude exactly what you did and paste any error you see. It's good at
diagnosing its own setup problems — you don't need to fix anything yourself.
