# Hackie

**Hackie** is a Chrome extension, and the team's FH26 pixel robot who lives in it (all of his art lives in [`extension/assets/`](extension/assets)): part drill sergeant, part worried parent. Hackie reads the page you're on and tracks how long you spend on work vs. slacking sites. On slacking sites it strolls along the edges of your screen, nags you to get back to your task or get up and move, and gets steadily less polite the longer you drift:

| Slack streak | What Hackie does |
| --- | --- |
| any | Walks the screen edges with a live slack timer and idle expressions (😊 😉 😮 💤 🤪 😎 💕). When your mouse comes near he stops and switches to the team's hover face, whose eyes follow the mouse |
| 5 min | **Nudge**: a speech bubble ("It looks like you're watching YouTube…") with *Back to work*, *I did it!* (an exercise break such as 10 squats), *N more min*, *It's for my task* |
| 10 min | **Whip**: whip crack (animation + synthesized sound), screen shake, red flash, video paused |
| 20 min | **Lockdown**: full-screen block. *Back to work* is instant; the exercise and "beg for more time" buttons unlock after 20 s. It follows you to every slacking page until you do real work |

Each snooze buys less time (5 → 3 → 2 min), and Hackie goes from worried to a full-on "angry mom" after 4 snoozes in a row. Whenever he's angry or furious he turns orange and red and flips through the team's six angry pictures, steam puffs and all. An exercise break or a couple of minutes of real work calms Hackie down. Clicking *Back to work* is only a promise (see "No easy way out"). Click Hackie (or its timer) for **Hackie's report**: slack streak, next warning, today's work and slacking, exercise breaks, mood, snoozes in a row, *Reset mood*, and a demo slider that fakes the slack streak.

Thresholds, sounds, and effects are all configurable (Gentle / Normal / Drill sergeant presets). Spend a couple of minutes on work and the streak resets. Blow through your daily slack budget and every warning escalates a level. For no warnings at all, **zero-slack mode** locks every slacking page the moment it opens.

> Hackathon prototype.

### Hackie's art: one source

All of Hackie's art lives in **`extension/assets/`**, and nothing else in the repo is used:

| File | Used for |
| --- | --- |
| `hackie.gif` | Idle Hackie (walker, popup, report), and the toolbar icons (`npm run icons`) |
| `sprites/angry-1.png` … `angry-6.png` | Angry and furious Hackie, one picture every 380 ms |
| `sprites/hover-base.png`, `hover-eye-left.png`, `hover-eye-right.png` | The hover face; the eyes slide up to 2 sprite pixels toward your mouse |
| `design/FH2026DESIGN-1.png`, `FH2026DESIGN-2.png` | The team's design drafts of those two faces (reference only) |
| `fonts/inter-latin-800-normal.woff2` | Inter ExtraBold for the popup, settings and report |

These are the team's files from `hackie V3.zip` (`hackie V4.zip` has the same art). The loose copies that used to sit at the repo root were byte-for-byte duplicates and have been removed. To add or change art, put it in `extension/assets/` and list it in `ART` at the top of [`extension/shared/mascot.js`](extension/shared/mascot.js). Everything that draws Hackie reads that list, and so does the service worker.

Web pages never load files from the extension. The service worker reads the art once and hands it to pages as `data:` URLs. YouTube's page logs every `chrome-extension://` load as *"Unsafe attempt to load URL … Domains, protocols and ports must match"*, and with no `web_accessible_resources`, sites also can't probe for the extension.

### Where this came from

Hackie is the merge of two team prototypes:

- **Get Up Hackie** (earlier "Get Up Clippy"), the rest of the team's extension, gave Hackie his look and his name: flat teal panels, Inter ExtraBold, and the pixel-art Hackie with hover eyes, angry frames and drag-to-move. It also brought the edge-walking mascot, random expressions and hover curiosity, the report panel, exercise nags with the "I did it!" counter, shrinking snoozes and the angry mom, and the "Run" test button and watch-time slider.
- **TaskWhip** is the engine:
  - work vs. slacking classification on every site, with escalation (whip and lockdown), stats and reports;
  - the AI judge, Ask Hackie and debug mode;
  - memory and the per-event AI;
  - angry Hackie overriding your clicks, replies in the bubble and AI label review;
  - zero-slack mode, persistent lockdowns, per-query search judging and sensitive sites.

There is now **one** extension: load it unpacked from `extension/` (see below). The old root-level copy of Get Up Hackie (`manifest.json`, `content.js`, `popup.*`, `sprites/`, `hackie V4/`) has been removed; its art lives on in `extension/assets/`.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/` folder. (The repo root isn't an extension anymore.)
3. The settings page opens. Tell Hackie your task (e.g. "my CMPT 225 linked list assignment"), add task keywords, and adjust the work/slacking site lists.
4. Pin the extension and click Hackie for today's report. The popup also has the team's quick controls: test a nudge, whip or lockdown, set "nudge me after N min", and reset Hackie's mood.

No build step and no dependencies. Edit files, then click the reload icon on the extension card.

### Getting a complete copy (and sharing one)

Load the **whole** `extension/` folder from a full download. Use `git clone` or `git pull`, or GitHub's green **Code → Download ZIP** for the repo. Don't assemble it from a pull request's changed files: a copy missing even one imported file fails with *"Service worker registration failed. Status code: 3"* and *"An unknown error occurred when fetching the script"*.

To check a copy before loading it, and to make a zip to share:

```bash
node tools/check-extension.mjs path/to/extension   # lists any missing or wrongly-cased files
npm run zip                                          # dist/hackie-extension-<version>.zip, checked and verified
```

The zip unpacks to a `hackie/` folder; load that folder unpacked. On macOS, double-click the zip in Finder to unpack it.

## How it decides what's work

In priority order:

1. **Sensitive sites** (see below) are always slacking and stay anonymous.
2. **Your per-page override** ("It's for my task" or the popup's "just this page").
3. **Search results are judged by what you searched for**, never by the search engine. Each query gets its own verdict: "c++ docs" on Google is work for a C++ task, "funny cat videos" is slacking, "weather tomorrow" is neutral. The AI judge reads the query; without it, your task and slacking keywords decide, and anything else is neutral. Site lists and site labels don't apply to search pages, so a search engine is never blocked wholesale. This covers Google, Bing, DuckDuckGo, Yahoo, Baidu, Yandex, Ecosia, Brave Search, Startpage, Kagi, Naver and YouTube search ([`lib/search.js`](extension/lib/search.js)).
4. **Your whole-site label** (the popup's "whole site" or the Top sites pills, toward work or neutral). The AI judge's verdict on the page itself still wins, so a cat video stays slacking on a site you labeled as work.
5. **Work sites list**: always work.
6. **AI judge verdict** (optional, cached 24 h per page).
7. **Slacking sites list**, unless the page mentions your task keywords more than slacking keywords. A YouTube video titled "Linked list in C++ explained" counts as work.
8. **Keywords** on unknown sites; otherwise neutral.

The content script reads the title, description, headings, YouTube video title and channel, Shorts/Reels format, a short text excerpt, and whether media is playing. Watching a video counts even when you aren't touching the mouse. Time only counts while Chrome is focused and you're active (or a video is playing).

## AI judge (optional, bring your own key)

Site lists can't tell a lecture from a cat video. Turn on the AI judge in settings and paste a key from any provider:

- **Anthropic (Claude)**: Messages API with structured JSON output.
- **OpenAI, OpenRouter, DeepSeek**: OpenAI-style Chat Completions with JSON mode.
- **Google Gemini**: uses Google's official OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) with an AI Studio key (`AIza…`).
  - The default model is `gemini-3.5-flash`, sent with `reasoning_effort: "low"`. Gemini 3 otherwise thinks for tens of seconds per nudge, and `"minimal"` isn't accepted.
  - Gemini 3's thought signatures (`extra_content`) are passed back on tool-calling turns.
  - In testing on 2026-11-07, 3.6 and 3.8 Flash were often overloaded (503), and 2.5 Flash is closed to new keys. Use **Load models** to see what your key can use.
  - Free-tier keys allow only a few requests per minute, so busy minutes can return 429.

All providers get a 45 s request limit and one automatic retry on 429/502/503.
- **Anything OpenAI-compatible**: Groq, Together, Mistral, Ollama, LM Studio… Set the base URL (e.g. `http://localhost:11434/v1`). The key is optional for local servers.

Only ambiguous pages are sent (never pages on your work list), at most N calls per hour, cached for 24 h. The verdict also gives Hackie a personalized roast. Keys are stored in `chrome.storage.local` and sent only to the provider you chose. Use **Test with a sample page** in settings to check your key and model name.

## Ask Hackie (agent) and debug mode

The same provider and key also power **Ask Hackie**, a tool-using agent. Find it in the popup's **Ask Hackie** tab and in the debug console. You can ask things like "How am I doing today?", "What did I slack on this week?", or "Why aren't you tracking?", or tell it to "mark reddit.com as work" or "give me a 15-minute break". It works whenever a key is set, even with the automatic judge switched off.

The harness lives in `lib/agent.js` (tool-calling loop) and `lib/agent-tools.js` (tool definitions):

| Tool | What it returns or does |
| --- | --- |
| `get_current_activity` | Current site and title, work/slack/neutral and why, whether time is counting, slack streak, warning level |
| `get_today_summary` | Today's totals, focus score, Hackie's events (incl. exercise breaks), top sites |
| `get_history` | Daily totals for the last 1–14 days, top work and slacking sites |
| `get_settings` | Task, site lists, thresholds, effects, AI provider and model (never keys) |
| `get_debug_log` | Recent tracking decisions, each with a plain-English "why" |
| `mark_site` | Reclassifies a site (only when you ask; reviewed like any label change, see "Talking back to Hackie") |
| `take_break` | Starts or ends a break (only when you ask) |

**Memory and mood.** Every question comes with all of Hackie's memory in the instructions: every site with its minutes and habit level, the work pages you use, your projects, facts and incidents. If it gets very large, the oldest and least-used entries are left out first. Ask Hackie also gets his mood right now (calm, annoyed, angry or furious; see "Angry Hackie" below) and why: snoozes, begging, the page you're on, today's minutes. The mood sets the tone:

- calm Hackie teases and praises real work;
- angry Hackie talks in clipped sentences with a CAPS word;
- furious Hackie throws your habits and deadlines back at you and orders you back to work.

He stays accurate in every mood. With memory turned off, he says he doesn't remember past days.

The loop speaks both Anthropic's Messages API (`tool_use`/`tool_result`) and OpenAI-style Chat Completions (`tool_calls`/`role: "tool"`). If a server can't do tool calls, Hackie answers from a snapshot of the read-only tools instead. The system prompt is `buildAgentSystem()` in `lib/agent.js`.

**Debug mode** (Settings → Debug mode) records every tracking decision. It adds a console to the bottom-left of every page showing:

- whether Chrome's window is focused, whether you're idle, and whether media is playing;
- how the page was classified and why, the slack streak, and the next warning;
- the AI status, recent decisions, and an Ask Hackie box.

Use it to answer "why didn't Hackie react?". A common answer: Hackie pauses whenever Chrome isn't the focused window. The console sits in a closed shadow root, so websites can't read it or drive the chat, but browser agents like Claude in Chrome can read it from the screen. Turn it off before screen sharing.

Debug mode also has a **testing switch**, "count time even when Chrome isn't focused", which ignores window focus and idleness. A browser agent can then drive a full test (walk, nudge, whip, lockdown) while you're in another app. The quickest demo triggers are the popup's **Test** row and the demo slider in Hackie's report.

## Memory and the per-event AI

**Memory** (`lib/memory.js`, Settings → Hackie's memory) is stored only in this browser. You can view it, edit it, or clear it. Hackie remembers:

- time per site (slacking / working / neutral) and visit counts;
- the work pages you actually use;
- projects (yours, or ones the AI saved);
- facts the AI learned ("binges Shorts after dinner");
- incidents: lockdowns, begging, fake comebacks, replies, label reviews, and tabs Hackie closed.

Sensitive sites are only kept as an anonymous "Private site" total. Sites that are a slacking **habit** get warnings sooner: thresholds × 0.6 after 30 min of total slacking, × 0.4 after 2 h, or when flagged by you or the AI.

**Per-event AI** (`lib/enforcer.js`, Settings → AI): on every nudge, whip, lockdown, beg and "Back to work", a second tool-using agent gets the page snapshot (sensitive pages redacted), the situation (level, streak, snoozes, begs, habit, today) and a memory summary. It then does three things:

- **Speech bubble:** writes a targeted message. The template line shows instantly and the AI's line replaces it about 1–3 s later.
- **Tab actions:** `list_tabs`, then `focus_tab` or `open_tab` to put a work page in front of you, and `close_tabs` to close slacking tabs.
- **Memory:** `remember` saves a fact, a project, or a slacking-habit site.

**Guardrails** (checked in the service worker, whatever the model asks for):

- **Closing tabs:** only allowed once you've begged for more time during lockdowns N times (default 2), or with the angry mom. Only tabs that classify as slacking get closed; never work, neutral or pinned tabs.
- **Opening tabs:** never a page that classifies as slacking. A work page is put in front before anything is closed. At most 8 closes and 3 opens per event.
- **Restoring:** every closed tab is listed in the popup's **Restore**.

"Back to work" lets the AI pick the destination from your open tabs and memory, falling back to your last work tab, then the task link, then your most-used work page. Without an AI key, begging still closes the current slacking site's tabs and opens your best remembered work page.

Settings can be exported and imported as JSON at the bottom of the settings page. API keys are left out unless you tick "Include API keys".

## No easy way out

"Real work" below means `thresholds.streakResetMin` of time on work pages (2 min by default).

**Lockdowns stay on.** Once a lockdown fires, it comes back on every slacking page: new tabs, other slacking sites, and the same page after you navigate away and back. It ends when:

- you do real work;
- Hackie allows an "I did it!" exercise break or a Reset mood;
- a page gets accepted as work ("It's for my task", a reply, or the popup's Work button).

A granted beg only pauses it for the begged minutes, and so does a break. Being away from Chrome (in another app, or idle) for the same 2 min also ends it; a new-tab page in a focused Chrome doesn't count as away.

**"Back to work" is a promise, not a reset.** The button still takes you to a work page, but your slack streak, snooze count, begs and any lockdown stay until you've done real work. While a lockdown or a promise is open, only work pages calm Hackie down; neutral pages don't.

Going back to slacking first, or staying on the page for 20 s, is a **fake comeback**. Hackie calls it out (`FAKE_COMEBACK` in `lib/lines.js`), warns you again at once, and gets angry. The second fake comeback makes him furious.

**Zero-slack mode** (Settings → How strict is Hackie?, off by default):

- Every page judged as slacking locks down the moment it opens.
- If the AI judge is still reading the page, Hackie waits for its verdict, so a lecture isn't locked by mistake.
- Your task page opens next to the locked tab, or comes to the front if it's already open. That happens once per page (per 30 min), so you can come back and argue. The task page is your task link, or else a project link or your most-used work page from memory.
- The lockdown has no beg or exercise buttons. To get out, go to work, argue in the reply box, or use "This page is actually for my task" (reviewed by the AI).

## Angry Hackie overrides your clicks

When you keep slacking, Hackie gets angry. While he's angry he can refuse the buttons that would let you off the hook. Set this in Settings → AI → "Angry Hackie can refuse my clicks" (on by default).

How angry he is (`lib/anger.js`; shown in the popup):

| Mood | When | Your clicks |
|---|---|---|
| Calm | default | always go through |
| Annoyed | one snooze, or a whip/lockdown on screen | always go through |
| Angry | 3 snoozes in a row, any begging during a lockdown, a whip on a strong habit site or over your daily budget, or he closed your tabs in the last 15 min, or a fake comeback | **the AI decides** (`lib/arbiter.js`) |
| Furious | more than 3 snoozes, begging as many times as it takes to get your tabs closed, or a second fake comeback | **refused**; the AI only writes the angry speech |

Refusable clicks:

- snooze and begging for more time;
- "It's for my task", dismiss (×), "I did it!", and reset mood;
- break, pause tracking, and the demo slider (when it lowers your streak);
- Restore (Hackie's closed tabs).

**Back to work is never refused.**

When Hackie is angry, the AI arbiter reads the page (redacted on sensitive sites), your situation and memory. It answers `{allow, message}` within 9 s. It leans towards refusing. "It's for my task" is allowed only when the page really serves your task (a linked-list lecture, yes; cat fails, no).

When a click is refused:

- the button is crossed out ("Snooze denied", "Override denied");
- Hackie cracks the whip and says why, angrily, in the bubble or the lockdown screen;
- the refusal is logged in memory.

Begging still counts when refused, so enough refused begs still get your tabs closed.

House rules that apply whatever the AI says:

- **Restore is locked** for 10 minutes after Hackie closes tabs (`restoreLockMin`).
- **"I did it!" works once per 10 minutes** while he's angry. An honest exercise break is allowed even when he's furious.
- **No AI or AI unreachable:** angry Hackie refuses snooze, begging, breaks, pause, reset mood, dismiss and the slider, and allows the rest.

## Talking back to Hackie

You can argue with Hackie, and he checks your label changes. Both need an AI provider and key (Settings → AI), even with the automatic judge off, and neither works on sensitive sites.

**Reply in the speech bubble** (`lib/appeal.js`). The nudge, whip and refusal bubbles and the lockdown screen have a reply box. Say why you're there ("this lecture is for my CMPT 225 quiz") and the AI judge hears you out:

- After a warning, it can reclassify the page as work. The warning or lockdown goes away.
- After a refused click, it can allow the click. A granted beg is a plain snooze.
- The page itself has to back you up. A good excuse doesn't turn cat videos into work.
- Angry Hackie is harder to talk round. Furious Hackie never un-refuses a click, but he can still reclassify a page that is plainly work.
- 3 replies per page per 10 minutes. Replies are logged to memory.
- Typing in the box doesn't trigger the site's shortcuts (YouTube's k, f or space).

**The AI reviews label changes** (`lib/review.js`). Any relabel that makes Hackie less strict (slacking → neutral or work, neutral → work) goes past the AI, and it can say no. That covers:

- the popup's Work and Neutral buttons, for just this page or the whole site;
- the Top sites pills;
- "It's for my task", in the bubble and on the lockdown screen;
- Ask Hackie's `mark_site` tool.

Making Hackie stricter is never reviewed. Neither are the site lists you type in Settings → "What counts as what"; those stay plain configuration.

Whole-site labels toward work or neutral are judged page by page. They're stored as site labels (`overrides.sites`), not added to your work list, and with the AI judge on, each page on that site still gets its own verdict. A cat video stays slacking even if you labeled YouTube as work.

- Without an AI key, nothing is reviewed.
- If the AI errors or is rate-limited, the change is refused and you can try again.
- 3 tries per page or site per 10 minutes, unless one was approved.

## Sensitive sites

Settings → **Sensitive sites** holds a list of domains that are never described to the AI. It defaults to the 2,056-domain [South Korea blocked-sites list](https://github.com/wpzzz/blocked-sites-in-south-korea/blob/main/kr.list) and is fully editable, with a "Restore the default list" button.

A page counts as sensitive if:

- its host (or a parent domain) is on the list, or
- it **proxies** a listed site: the site appears in the URL (plain, URL-encoded, double-encoded, or base64), in a path (`web.archive.org/web/…/https://site`), as a Google Translate proxy (`site-com.translate.goog`), or in the page's canonical link, `og:url`, or `<base>`.

On sensitive pages:

- The AI receives only *"Page information blocked: the user is viewing sensitive content"*. No URL, domain, title, or text.
- Nothing readable is stored. Time is logged as "Private site", never by name, in the popup and report.
- The page counts as slacking, and "It's for my task" and the reply box are hidden. To change that, remove the site from the list.

To refresh the bundled default list: `node tools/update-sensitive-list.mjs` (or pass a local file path).

## Project layout

```
extension/
  manifest.json            MV3 manifest
  background.js            service worker: time banking, classification, escalation, messaging
  content/content.js       page reader + walking Hackie UI (shadow DOM), report panel, whip, lockdown, debug console
  shared/mascot.js         draws Hackie from assets/ (the ART list): idle GIF, angry frames, hover eyes, emoji badges, whip
  assets/                  all of Hackie's art (the one source): hackie.gif, sprites/, design/, Inter ExtraBold font
  shared/theme.css         design tokens (light + dark)
  popup/                   today's report, quick classify, break/pause
  options/                 task, site lists, strictness, effects, AI judge, sensitive sites, data export
  report/                  14-day report page
  lib/                     pure modules: classify, search (per-query judging), stats, defaults, lines, ai, agent, agent-tools, debug, sensitive,
                           memory, enforcer (per-event AI), anger + arbiter (refusing clicks), appeal (replies),
                           review (label review)
  data/sensitive-sites.js  generated default sensitive list
  icons/                   generated PNGs
tests/                     node:test unit tests + headless Chrome e2e
tools/                     icons from hackie.gif (gif.mjs decoder), sensitive-list updater
```

## Tests

```bash
npm test
```

Unit tests cover the classifier and site labels, stats, AI adapters (mocked `fetch`), sensitive-site matching, the agent and its tools, memory, the per-event AI, the anger rules (including fake comebacks) and arbiter, Ask Hackie's memory and mood, replies, label review, and the lockdown, fake-comeback and zero-slack lines. No install needed (Node 20+).

```bash
npm run e2e
```

The end-to-end test launches Chrome headless with a **throwaway profile**, loads the extension via the DevTools protocol, serves fake video/work/proxy pages on `*.localhost`, and walks through nudge → whip → arrest → back to work. It also covers the AI judge, Ask Hackie, the per-event AI closing tabs after begging, and angry Hackie refusing a snooze, all against a fake OpenAI-compatible server. It checks that Hackie's art reaches pages only as `data:` URLs, the angry frames and hover eyes, and that Ask Hackie gets memory and mood. It covers lockdowns that persist across pages, fake comebacks, replies in the bubble (including keys staying out of the page's shortcuts), label review and zero-slack mode. It also covers the sensitive-site redaction and saves screenshots. Set `CHROME_PATH` if Chrome isn't in the default location, `E2E_OUT` for the screenshot folder, or `HEADLESS=0` to watch.

```bash
AI_PROVIDER=deepseek AI_KEY=sk-... node tests/live-ai.mjs
```

This optional live check hits a real provider. It lists models, judges a cat video vs. a lecture, checks that sensitive pages are redacted, runs the agent's tool loop on fake data, checks that the enforcer closes slacking tabs after begging, and checks that the arbiter refuses a 4th snooze but allows a real lecture. It also checks replies (an excuse for cat videos stays slacking, a lecture gets reclassified, furious Hackie keeps a snooze refused, a prompt injection fails) and label review (cat page denied, lecture approved). It costs a fraction of a cent. `AI_MODEL` and `AI_BASE_URL` work too (e.g. `AI_PROVIDER=custom AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=llama3.1`).

Debugging: turn on **Debug mode** in settings, or open the service worker console from `chrome://extensions` and run `await taskwhip.refresh()`, `await taskwhip.popupState()` or `await taskwhip.ask('why aren\'t you tracking?')`. The `taskwhip` global, the `taskwhip-hackie` and `taskwhip-console` elements and the `taskwhip-tick` alarm keep their pre-merge names so that open tabs, saved alarms, backups and the tests keep working.
