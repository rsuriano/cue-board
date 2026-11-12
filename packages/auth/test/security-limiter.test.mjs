// Security review, finding 6: a successful redeem or login cleared the IP's wrong-guess counter, so someone holding
// one valid invite code could slip it in after every 4 wrong guesses and never be blocked. Failures now expire with
// time only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { auth } from './helpers.mjs';
import { CodeStore } from '../src/codes.mjs';

test('a valid code slipped in between wrong guesses does not reset the block', async () => {
  const a = await auth({ failMax: 5 });
  try {
    const good = new CodeStore(a.dir).createCode({ label: 'Mine' });
    const redeem = code => a.call('POST', '/redeem', { email: 'eve@example.com', code, product: 'cue-board' });
    let blocks = 0, wrong = 0;
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 4; i++) { wrong++; if ((await redeem('not-a-code-' + wrong)).status === 429) blocks++; }
      const r = await redeem(good.code);
      if (r.status === 429) blocks++;
    }
    assert.ok(blocks > 0, `40 wrong guesses, ${blocks} blocks`);
    assert.equal((await redeem('not-a-code-again')).status, 429, 'blocked by now');
  } finally { await a.srv.close(); }
});
