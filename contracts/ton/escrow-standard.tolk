tolk 1.4.2

// One escrow per allowlisted reference-layout jetton. Fixed 2-of-3 Ed25519 committee.
struct Config { domain: uint256; keys: cell; master: address; walletCode: cell; cap: uint64; }
struct Recovery { nextRefund: uint64; refunds: map<uint64, cell>; pending: map<uint64, cell>; }
struct Storage { config: Cell<Config>; locked: uint64; nextDeposit: uint64; nextRelease: uint64; recovery: Cell<Recovery>; deposits: map<uint64, cell>; releases: map<uint256, uint8>; }
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
  var recovery = s.recovery.load();
  val c = s.config.load();
  val op = in.body.preloadUint(32);
  if (op == 0x7362d09c) {
      val msg = lazy Deposit.fromSlice(in.body);
      assert(in.senderAddress == wallet(c)) throw 401;
      assert(msg.amount > 0 && msg.amount <= 18446744073709551615 && msg.from.getWorkchain() == 0) throw 402;
      var payload = msg.payload;
      var valid = msg.amount <= c.cap && s.locked + msg.amount <= c.cap;
      var recipient = 0;
      if (payload.remainingBitsCount() < 1) { valid = false; }
      else {
        if (payload.loadBool()) {
          if (payload.remainingRefsCount() != 1 || payload.remainingBitsCount() != 0) { valid = false; }
          else { payload = payload.loadRef().beginParse(); }
        }
        if (payload.remainingBitsCount() == 256 && payload.remainingRefsCount() == 0) { recipient = payload.loadUint(256); }
        else { valid = false; }
      }
      if (valid) {
        val id = s.nextDeposit;
        s.deposits.set(id, beginCell().storeUint(msg.amount, 64).storeUint(recipient, 256).storeAddress(msg.from).endCell());
        s.nextDeposit += 1; s.locked += msg.amount;
      } else {
        // Unclaimable notification: record an exact refund to its authenticated
        // original sender. No committee can redirect it or select its amount.
        recovery.refunds.set(recovery.nextRefund, beginCell().storeUint(msg.amount,64).storeAddress(msg.from).endCell());
        recovery.nextRefund += 1;
      }
  } else if (op == 0x42524704) {
      // Quorum attests a finalized downstream bounce returned funds to this wallet.
      // This only reopens an existing exact pending instruction; no arbitrary payout.
      var body = in.body; body.skipBits(32);
      val q = body.loadUint(64); val evidence = body.loadUint(256);
      val a = body.loadUint(8); val b = body.loadUint(8);
      val sigA = body.loadRef(); val sigB = body.loadRef(); body.assertEnd();
      assert(a < b && b < 3) throw 404;
      val pCell = recovery.pending.mustGet(q);
      val digest = beginCell().storeUint(op,32).storeAddress(contract.getAddress()).storeUint(c.domain,256)
          .storeRef(beginCell().storeUint(q,64).storeUint(evidence,256).storeRef(pCell).endCell()).endCell().hash();
      var ka=c.keys.beginParse(); ka.skipBits(a*256); var kb=c.keys.beginParse(); kb.skipBits(b*256);
      assert(isSignatureValid(digest,sigA.beginParse(),ka.loadUint(256))) throw 407;
      assert(isSignatureValid(digest,sigB.beginParse(),kb.loadUint(256))) throw 408;
      var pending=pCell.beginParse(); val receipt=pending.loadUint(256); val amount=pending.loadUint(64);
      recovery.pending.delete(q);
      if(pending.loadBool()) { s.releases.delete(receipt); s.locked += amount; }
      else { recovery.refunds.set(receipt as uint64,beginCell().storeUint(amount,64).storeAddress(pending.loadAddress()).endCell()); }
  } else if (op == 0x42524703) {
      assert(in.valueCoins >= ton("0.15")) throw 403;
      var request = in.body; request.skipBits(32); val id = request.loadUint(64); request.assertEnd();
      var refund = recovery.refunds.mustGet(id).beginParse(); val amount = refund.loadUint(64); val recipient = refund.loadAddress();
      recovery.refunds.delete(id); val q = s.nextRelease; s.nextRelease += 1;
      recovery.pending.set(q,beginCell().storeUint(id,256).storeUint(amount,64).storeBool(false).storeAddress(recipient).endCell());
      createMessage({dest:wallet(c),value:ton("0.1"),bounce:BounceMode.Only256BitsOfBody,
        body:Transfer {queryId:q,amount:amount as coins,destination:recipient,responseDestination:contract.getAddress(),customPayload:null,forwardTonAmount:ton("0.01"),forwardPayload:beginCell().storeBool(false).endCell().beginParse()}
      }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
  } else if (op == 0x42524701) {
      var body = in.body; body.skipBits(32);
      val msg = lazy Release.fromSlice(body);
      assert(in.valueCoins >= ton("0.15")) throw 403;
      assert(msg.recipient.getWorkchain() == 0) throw 411;
      assert(msg.a < msg.b && msg.b < 3) throw 404;
      assert(msg.amount > 0 && s.locked >= msg.amount) throw 405;
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
      recovery.pending.set(q, beginCell().storeUint(msg.receipt, 256).storeUint(msg.amount, 64).storeBool(true).endCell());
      s.locked -= msg.amount;
      createMessage({dest: wallet(c), value: ton("0.1"), bounce: BounceMode.Only256BitsOfBody,
        body: Transfer {queryId:q, amount:msg.amount as coins, destination:msg.recipient, responseDestination:contract.getAddress(),
          customPayload:null, forwardTonAmount:ton("0.01"), forwardPayload:beginCell().storeBool(false).endCell().beginParse()}
      }).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
  } else if (op == 0xd53276db) { return; } else { throw 400; }
  s.recovery = recovery.toCell();
  contract.setData(s.toCell());
}

fun onBouncedMessage(in: InMessageBounced) {
  var s = Storage.fromCell(contract.getData());
  var recovery = s.recovery.load();
  assert(in.senderAddress == wallet(s.config.load())) throw 401;
  var b = in.bouncedBody;
  b.skipBouncedPrefix();
  if (b.loadUint(32) != 0x0f8a7ea5) { return; }
  val q = b.loadUint(64);
  assert(recovery.pending.exists(q)) throw 409;
  var p = recovery.pending.mustGet(q).beginParse();
  val receipt = p.loadUint(256);
  val amount = p.loadUint(64);
  recovery.pending.delete(q);
  if (p.loadBool()) { s.releases.delete(receipt); s.locked += amount; }
  else { recovery.refunds.set(receipt as uint64,beginCell().storeUint(amount,64).storeAddress(p.loadAddress()).endCell()); }
  s.recovery = recovery.toCell();
  contract.setData(s.toCell());
}
get fun locked(): int { return Storage.fromCell(contract.getData()).locked; }
get fun depositCount(): int { return Storage.fromCell(contract.getData()).nextDeposit; }
get fun deposit(id: uint64): cell { return Storage.fromCell(contract.getData()).deposits.mustGet(id); }
get fun releaseState(id: uint256): int { val s = Storage.fromCell(contract.getData()); return s.releases.exists(id) ? s.releases.mustGet(id) : 0; }

get fun refundCount(): int { return Storage.fromCell(contract.getData()).recovery.load().nextRefund; }
get fun refund(id: uint64): cell { return Storage.fromCell(contract.getData()).recovery.load().refunds.mustGet(id); }

get fun pending(id: uint64): cell { return Storage.fromCell(contract.getData()).recovery.load().pending.mustGet(id); }
get fun nextRelease(): int { return Storage.fromCell(contract.getData()).nextRelease; }
