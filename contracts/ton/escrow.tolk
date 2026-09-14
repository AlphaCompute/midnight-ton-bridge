tolk 1.4.2

// One escrow per allowlisted test jetton. Fixed 2-of-3 Ed25519 committee.
struct Config { domain: uint256; keys: cell; master: address; walletCode: cell; cap: uint64; }
struct Storage { config: Cell<Config>; locked: uint64; nextDeposit: uint64; nextRelease: uint64; deposits: map<uint64, cell>; releases: map<uint256, uint8>; pending: map<uint64, cell>; }
struct (0x7362d09c) Deposit { queryId: uint64; amount: coins; from: address; payload: RemainingBitsAndRefs; }
struct Release { receipt: uint256; amount: uint64; recipient: address; a: uint8; b: uint8; sigA: cell; sigB: cell; }
struct (0x0f8a7ea5) Transfer { queryId: uint64; amount: coins; destination: address; responseDestination: address; customPayload: cell?; forwardTonAmount: coins; forwardPayload: RemainingBitsAndRefs; }


fun wallet(c: Config): address {
  val data = beginCell().storeCoins(0).storeAddress(contract.getAddress()).storeAddress(c.master).storeRef(c.walletCode).endCell();
  return AutoDeployAddress {workchain:0, stateInit: {code:c.walletCode, data:data}}.calculateAddress();
}

fun onInternalMessage(in: InMessage) {
  if (in.body.isEmpty()) { return; }
  var s = Storage.fromCell(contract.getData());
  val c = s.config.load();
  val op = in.body.preloadUint(32);
  if (op == 0x7362d09c) {
      val msg = lazy Deposit.fromSlice(in.body);
      assert(in.senderAddress == wallet(c)) throw 401;
      assert(msg.amount > 0 && msg.amount <= c.cap && s.locked + msg.amount <= c.cap) throw 402;
      var payload = msg.payload;
      // Support TEP-74 inline or ref forward_payload; require exactly 256 bits.
      if (payload.loadBool()) { payload = payload.loadRef().beginParse(); }
      val recipient = payload.loadUint(256);
      payload.assertEnd();
      val id = s.nextDeposit;
      s.deposits.set(id, beginCell().storeUint(msg.amount, 64).storeUint(recipient, 256).storeAddress(msg.from).endCell());
      s.nextDeposit += 1;
      s.locked += msg.amount;
  } else if (op == 0x42524701 || op == 0x42524702) {
      var body = in.body; body.skipBits(32);
      val msg = lazy Release.fromSlice(body);
      val recovery = op == 0x42524702;
      assert(in.valueCoins >= ton("0.15")) throw 403;
      assert(msg.a < msg.b && msg.b < 3) throw 404;
      assert(msg.amount > 0 && (recovery || s.locked >= msg.amount)) throw 405;
      assert(!s.releases.exists(msg.receipt)) throw 406;
      val digest = beginCell().storeUint(op, 32).storeAddress(contract.getAddress()).storeUint(c.domain, 256)
        .storeRef(beginCell().storeUint(msg.receipt, 256).storeUint(msg.amount, 64).storeAddress(msg.recipient).endCell()).endCell().hash();
      var ka = c.keys.beginParse(); ka.skipBits(msg.a * 256);
      var kb = c.keys.beginParse(); kb.skipBits(msg.b * 256);
      assert(isSignatureValid(digest, msg.sigA.beginParse(), ka.loadUint(256))) throw 407;
      assert(isSignatureValid(digest, msg.sigB.beginParse(), kb.loadUint(256))) throw 408;
      val q = s.nextRelease;
      s.nextRelease += 1;
      s.releases.set(msg.receipt, 1); // submitted; NOT an assertion of recipient delivery
      s.pending.set(q, beginCell().storeUint(msg.receipt, 256).storeUint(msg.amount, 64).storeBool(!recovery).endCell());
      if (!recovery) { s.locked -= msg.amount; }
      createMessage({dest: wallet(c), value: ton("0.1"), bounce: BounceMode.Only256BitsOfBody,
        body: Transfer {queryId:q, amount:msg.amount as coins, destination:msg.recipient, responseDestination:contract.getAddress(),
          customPayload:null, forwardTonAmount:ton("0.01"), forwardPayload:beginCell().storeBool(false).endCell().beginParse()}
      }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
  } else { throw 400; }
  contract.setData(s.toCell());
}

fun onBouncedMessage(in: InMessageBounced) {
  var s = Storage.fromCell(contract.getData());
  assert(in.senderAddress == wallet(s.config.load())) throw 401;
  var b = in.bouncedBody;
  b.skipBouncedPrefix();
  if (b.loadUint(32) != 0x0f8a7ea5) { return; }
  val q = b.loadUint(64);
  assert(s.pending.exists(q)) throw 409;
  var p = s.pending.mustGet(q).beginParse();
  val receipt = p.loadUint(256);
  val amount = p.loadUint(64);
  s.pending.delete(q);
  s.releases.delete(receipt); // wallet rejected transfer; safe to retry same authorization
  if (p.loadBool()) { s.locked += amount; }
  contract.setData(s.toCell());
}
get fun locked(): int { return Storage.fromCell(contract.getData()).locked; }
get fun depositCount(): int { return Storage.fromCell(contract.getData()).nextDeposit; }
get fun deposit(id: uint64): cell { return Storage.fromCell(contract.getData()).deposits.mustGet(id); }
get fun releaseState(id: uint256): int { val s = Storage.fromCell(contract.getData()); return s.releases.exists(id) ? s.releases.mustGet(id) : 0; }
