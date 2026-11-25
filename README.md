# Say Hello 👋 Room Bingo for common rooms

Ten strangers in a room, all on their phones. Nobody wants to say the first hello.
**Say Hello** gives everyone a reason to.

1. Someone taps **Start a room** and puts the QR on a table, TV or WhatsApp group.
2. Everyone scans. No app, no sign-up. They enter a first name and answer 4 quick questions.
3. Each player gets a **3×3 bingo card built from the real people in the room**:
   *"Find someone who's been to Spiti"*, *"Find who says: I can moonwalk"*.
4. To unlock a square, you find that person and enter the **4-digit code** on their screen.
   You can only verify it by talking to them.
5. Each unlock shows a conversation starter. Three in a row is **BINGO** 🎉

Rules that keep it social:
- One person can fill at most 2 squares on your card, so you have to meet several people.
- Cards upgrade live: generic squares turn into real people's facts as more people join.
- 8 wrong codes per minute and you're paused, so guessing doesn't pay.

## Pages
| URL | What |
|---|---|
| `/` | Start or join a room |
| `/?r=CODE` | Join link (this is what the QR opens) |
| `/?r=CODE&screen=1` | Big-screen mode for a TV/laptop: big QR, live leaderboard, live feed |
| `/stats` | Total people played, hellos said, rooms, bingos (the numbers for the Build Sprint) |

## Run locally
```
node server.js
```
Open http://localhost:3000. Node 18+, **no dependencies**, nothing to install.

## Deploy (Render, free, about 5 minutes)
1. Push this folder to a GitHub repo.
2. https://render.com → New → **Web Service** → pick the repo.
3. Runtime: Node · Build command: *(leave empty)* · Start command: `node server.js` · Instance: Free.
4. Free instances sleep after 15 min idle. To keep the "opens in seconds" promise, add a free
   https://cron-job.org job hitting `https://YOUR-APP.onrender.com/healthz` every 10 minutes.

Rooms live in memory and expire after 8 hours of inactivity. Stats are written to `stats.json`.
On Render's free tier, a redeploy resets the file, so note your numbers before redeploying.

## Stack
Plain Node `http` server (≈300 lines) plus vanilla HTML/CSS/JS. Polling every 2.5s, which works on any
host and any phone. QR images come from api.qrserver.com.
