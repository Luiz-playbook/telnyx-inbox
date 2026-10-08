// AI-1088: list and download Kernel session replays.
//
//   node --env-file=.env scripts/kernel-replay.js                      # what replays exist
//   node --env-file=.env scripts/kernel-replay.js <sessionId> <replayId> [out.mp4]
//
// Exists so sharing a run with Marx is one command rather than a curl with a bearer token
// pasted by hand. The key comes from .env like everything else here.
//
// TWO THINGS THAT CATCH PEOPLE OUT, both learned the hard way:
//
//  1. REPLAYS ONLY RECORD HEADFUL. A headless session answers POST /replays with "headless
//     browsers don't support replays at this time", so a run that wants a recording must set
//     replay: true — openKernelSession then forces headless off for you. The dashboard's
//     "live view not available in headless mode" is a different thing: that is watching in
//     real time, which no recording is involved in.
//  2. RECORDING IS OPT-IN AND THE SESSION MUST BE STOPPED, NOT JUST DELETED. Stopping the
//     replay is what persists the video. Once persisted it outlives the session — a deleted
//     session's replay still downloads fine.

const KEY = (process.env.KERNEL_API_KEY || '').trim();
if (!KEY) throw new Error('KERNEL_API_KEY not set (it lives in .env)');
const API = 'https://api.onkernel.com';
const H = { Authorization: 'Bearer ' + KEY };

const [, , sessionId, replayId, outArg] = process.argv;

if (!sessionId) {
  // Only LIVE sessions are listable; a session Kernel has already reaped is gone from here even
  // though its replay may still be downloadable. So this lists what it can and then says so.
  const r = await fetch(API + '/browsers', { headers: H });
  if (!r.ok) throw new Error('list browsers: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const rows = await r.json();
  if (!rows.length) {
    console.log('No live sessions.\n');
  } else {
    console.log(`${rows.length} live session(s):\n`);
    for (const b of rows) {
      const id = b.session_id || b.id;
      console.log(`  ${id}  headless=${b.headless}  stealth=${b.stealth}  created=${b.created_at || '?'}`);
      const rr = await fetch(`${API}/browsers/${id}/replays`, { headers: H });
      const body = await rr.json().catch(() => null);
      if (!rr.ok) { console.log(`     replays: ${(body && body.message) || rr.status}`); continue; }
      const list = Array.isArray(body) ? body : (body && body.replays) || [];
      if (!list.length) { console.log('     replays: none started'); continue; }
      for (const rep of list) {
        const rid = rep.replay_id || rep.id;
        console.log(`     replay ${rid}`);
        console.log(`       node --env-file=.env scripts/kernel-replay.js ${id} ${rid}`);
      }
    }
  }
  console.log('Already know the ids? Pass them:');
  console.log('  node --env-file=.env scripts/kernel-replay.js <sessionId> <replayId> [out.mp4]');
  process.exit(0);
}

if (!replayId) throw new Error('usage: kernel-replay.js <sessionId> <replayId> [out.mp4]');

const out = outArg || `kernel-replay-${replayId}.mp4`;
const url = `${API}/browsers/${sessionId}/replays/${replayId}`;
process.stdout.write(`downloading ${url}\n`);

const r = await fetch(url, { headers: H, redirect: 'follow' });
if (!r.ok) throw new Error(`download failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
const buf = Buffer.from(await r.arrayBuffer());

// A wall or an error page can arrive with a 200 and be saved as a .mp4 nobody can play; an
// MP4 always carries 'ftyp' at bytes 4-8.
if (buf.length < 1000 || buf.slice(4, 8).toString() !== 'ftyp') {
  throw new Error(`that is not an mp4 (${buf.length} bytes): ${buf.slice(0, 150).toString()}`);
}

const { writeFileSync } = await import('node:fs');
writeFileSync(out, buf);
console.log(`saved ${out} (${(buf.length / 1024).toFixed(0)} KB)`);
