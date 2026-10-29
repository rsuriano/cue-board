// How big Chromium's SDP gets for the media data channel (docs/media-p2p.md, checkCtl's SDP limit):
// node design/sdp-size.mjs. Offer and answer as sent (right after setLocalDescription) and once ICE gathering is done
// (every candidate inside), with no ICE servers and with STUN/TURN servers configured.
import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/ramiro/testkit/')('playwright-core');

const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent('<p>sdp</p>');
const out = await page.evaluate(async () => {
  const gathered = pc => new Promise(ok => { if (pc.iceGatheringState === 'complete') ok(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && ok(); setTimeout(ok, 8000); });
  const run = async iceServers => {
    const a = new RTCPeerConnection({ iceServers }), b = new RTCPeerConnection({ iceServers });
    a.createDataChannel('cue-media', { ordered: true });
    await a.setLocalDescription(await a.createOffer());
    const offerNow = a.localDescription.sdp;
    await gathered(a);
    const offerFull = a.localDescription.sdp;
    await b.setRemoteDescription({ type: 'offer', sdp: offerFull });
    await b.setLocalDescription(await b.createAnswer());
    const answerNow = b.localDescription.sdp;
    await gathered(b);
    const answerFull = b.localDescription.sdp;
    a.close(); b.close();
    const cands = offerFull.split('\r\n').filter(l => l.startsWith('a=candidate'));
    return { offerNow: offerNow.length, offerFull: offerFull.length, answerNow: answerNow.length, answerFull: answerFull.length,
      candidates: cands.length, longestCandidate: Math.max(0, ...cands.map(l => l.length)),
      sealedJson: JSON.stringify({ t: 'offer', sdp: offerFull, s: 123456 }).length };
  };
  return {
    none: await run([]),
    servers: await run([{ urls: 'stun:127.0.0.1:3478' }, { urls: 'stun:[::1]:3478' }, { urls: 'turn:127.0.0.1:3478', username: 'u', credential: 'p' }]),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
